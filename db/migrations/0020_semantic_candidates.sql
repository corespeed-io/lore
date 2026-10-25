-- migrate:up
-- Schema revision 20: the semantic channel of Memory search moves into
-- lore.semantic_candidates, a SECURITY DEFINER function, as the lexical channels
-- moved into lore.lexical_candidates in 0012.
--
-- Why a function. Through revision 19 the engine's search statement found the
-- nearest chunks as lore_app, on the tables, under RLS. Every embedded chunk of the
-- Workspace passed the memory_chunks and memory_chunk_embeddings policies, and each
-- of those looks up the chunk's Memory again: three Memory lookups and one
-- generation lookup for each chunk, one row at a time, before a single distance was
-- compared. On 55,000 visible chunks of 1024 dimensions the channel took about
-- 1.5 s, while the same exact scan took about 0.3 s without those lookups. This
-- function runs as its owner, which is not subject to the policies. It checks
-- visibility once for each Memory, computes each distance in the scan (where a
-- parallel worker can compute it), and looks up a chunk's ordinal only for the top
-- candidates.
--
-- What keeps it safe is what keeps lore.lexical_candidates safe:
--   * Visibility is the memories_select policy's own predicate, read from the same
--     Actor settings: the Workspace must be lore.current_workspace_id(), the Actor
--     must pass lore.can_read_workspace, and a private Memory must belong to
--     lore.current_user_id(). The function takes no user or visibility argument.
--     With no Actor context, or another Workspace's id, it returns nothing.
--   * It returns ids and ranks, never content or vectors. The engine's search
--     statement joins every candidate back to memory_chunks and memories as
--     lore_app, under RLS, before fusing.
--   * EXECUTE is granted to lore_app alone. search_path is pinned with pg_temp last
--     and every relation and type is schema-qualified.
--
-- What it returns: exactly the candidates, with exactly the ranks, of the semantic
-- channel the engine's search statement ran under RLS through revision 19 (the
-- reference statement in @corespeed/lore-core/testing): chunks of the visible,
-- filtered Memories whose vector belongs to an active or retiring generation of the
-- requested provider, model, revision, and dimensions, at most distance_threshold
-- from the query, ordered by distance, then the Memory's updated_at (newest first),
-- then the chunk's ordinal (last first), then the chunk id. The first step keeps the
-- top candidate_limit rows by distance and updated_at WITH TIES, so every row the
-- full order can place in the top candidate_limit is kept, and only those rows need
-- their chunk's ordinal.
--
-- The search stays exact. The generation-scoped HNSW index serves no query yet;
-- approximate search is a ranking change and needs its own evaluation.
--
-- compatible_from stays 9. This adds one function; an application of revision 9
-- through 19 does not use it and loses nothing. CREATE FUNCTION validates the body,
-- which takes ACCESS SHARE on the tables it names and blocks no read or write.
CREATE FUNCTION lore.semantic_candidates(
    target_workspace_id uuid,
    query_embedding public.vector,
    embedding_provider text,
    embedding_model text,
    embedding_revision text,
    embedding_dimensions integer,
    distance_threshold double precision,
    scope_filter public.memory_scope,
    updated_after timestamp with time zone,
    updated_before timestamp with time zone,
    metadata_filter jsonb,
    excluded_memory_ids uuid[],
    candidate_limit integer
) RETURNS TABLE(chunk_id uuid, memory_id uuid, candidate_rank bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    ROWS 200
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    SET plan_cache_mode TO 'force_custom_plan'
    AS $$
  WITH nearest AS (
    SELECT embedded.chunk_id, embedded.memory_id, memory.updated_at, embedded.distance
    FROM (
      SELECT
        candidate.chunk_id,
        candidate.memory_id,
        candidate.workspace_id,
        -- Computed in the scan, after the generation filter: a vector of another
        -- generation may have another width, which the operator would refuse.
        -- Adding zero changes no distance, but the planner can match only a bare
        -- `embedding <=> query` to the HNSW index, so no ORDER BY on this distance
        -- becomes that approximate scan (it stops after hnsw.ef_search candidates,
        -- before the filters); this channel is exact.
        (candidate.embedding OPERATOR(public.<=>) query_embedding) + 0.0::double precision AS distance
      FROM public.memory_chunk_embeddings candidate
      WHERE candidate.workspace_id = target_workspace_id
        AND candidate.generation_id = ANY (ARRAY(
          SELECT generation.id
          FROM public.embedding_generations generation
          WHERE generation.embedding_provider = semantic_candidates.embedding_provider
            AND generation.embedding_model = semantic_candidates.embedding_model
            AND generation.embedding_revision = semantic_candidates.embedding_revision
            AND generation.embedding_dimensions = semantic_candidates.embedding_dimensions
            AND generation.status IN ('active'::public.embedding_generation_status,
                                      'retiring'::public.embedding_generation_status)
        ))
    ) embedded
    JOIN public.memories memory
      ON memory.id = embedded.memory_id
     AND memory.workspace_id = embedded.workspace_id
    WHERE query_embedding IS NOT NULL
      AND target_workspace_id = lore.current_workspace_id()
      AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
      AND (memory.scope = 'shared'::public.memory_scope OR memory.owner_user_id = lore.current_user_id())
      AND (scope_filter IS NULL OR memory.scope = scope_filter)
      AND (updated_after IS NULL OR memory.updated_at >= updated_after)
      AND (updated_before IS NULL OR memory.updated_at < updated_before)
      AND (metadata_filter IS NULL OR memory.metadata @> metadata_filter)
      AND NOT (memory.id = ANY(excluded_memory_ids))
      AND embedded.distance <= distance_threshold
    ORDER BY embedded.distance, memory.updated_at DESC
    FETCH FIRST candidate_limit ROWS WITH TIES
  )
  SELECT
    nearest.chunk_id,
    nearest.memory_id,
    row_number() OVER (
      ORDER BY nearest.distance, nearest.updated_at DESC, chunk.ordinal DESC, nearest.chunk_id
    ) AS candidate_rank
  FROM nearest
  JOIN public.memory_chunks chunk
    ON chunk.id = nearest.chunk_id
   AND chunk.memory_id = nearest.memory_id
   AND chunk.workspace_id = target_workspace_id
  ORDER BY nearest.distance, nearest.updated_at DESC, chunk.ordinal DESC, nearest.chunk_id
  LIMIT candidate_limit
$$;
COMMENT ON FUNCTION lore.semantic_candidates(uuid, public.vector, text, text, text, integer, double precision, public.memory_scope, timestamp with time zone, timestamp with time zone, jsonb, uuid[], integer) IS 'Semantic search candidates (ids and ranks) under the memories_select predicate; the engine re-reads every candidate under RLS.';
REVOKE ALL ON FUNCTION lore.semantic_candidates(uuid, public.vector, text, text, text, integer, double precision, public.memory_scope, timestamp with time zone, timestamp with time zone, jsonb, uuid[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.semantic_candidates(uuid, public.vector, text, text, text, integer, double precision, public.memory_scope, timestamp with time zone, timestamp with time zone, jsonb, uuid[], integer) TO lore_app;

UPDATE public.lore_system_state
SET schema_revision = 20, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
