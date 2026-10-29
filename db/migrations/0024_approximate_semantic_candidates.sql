-- migrate:up
-- Schema revision 24: lore.semantic_candidates (0020) answers a large Workspace
-- from the HNSW index, and still compares every vector of a small one.
--
-- Why. The exact comparison reads every vector of the Workspace's generation: about
-- 0.3 s for 55,000 chunks, and linear beyond that. The HNSW index on
-- memory_chunk_embeddings visits a small part of its graph instead. It is
-- approximate, and it is one index over every Workspace, so the Workspace,
-- generation, and visibility filters apply to what the walk returns.
--
-- How it answers, with exact_scan_limit from the engine
-- (RETRIEVAL_SEMANTIC_POLICY.exactScanLimit):
--   1. It counts the Workspace's vectors of the requested generations, stopping at
--      exact_scan_limit. Below it, the answer is the exact comparison of 0020,
--      unchanged.
--   2. At or above it, it walks the HNSW index in distance order, keeping only
--      visible, filtered rows, until candidate_limit rows have passed. With
--      pgvector 0.8 or later, hnsw.iterative_scan (relaxed_order) lets the walk go
--      past hnsw.ef_search; the rows are sorted again in full below (on distance + 0,
--      so PostgreSQL 17+ cannot reuse the walk's approximate order), so relaxed order
--      costs no misordering. The distance threshold applies after the walk: a row past it
--      cannot precede one within it.
--   3. If the walk returned fewer than candidate_limit rows (it stopped at
--      hnsw.max_scan_tuples, as it does when the Workspace is a small share of the
--      index, or pgvector is older than 0.8), the answer is the exact comparison.
--      A short approximate answer is never returned.
-- The bare `embedding <=> query` in step 2 is what lets the planner use the index;
-- the exact comparison keeps `+ 0` so it never does.
--
-- Visibility is the memories_select predicate, applied in both paths before any row
-- counts toward the limit, and the engine still reads every candidate back under
-- RLS. tests/server/semantic-candidates.test.ts runs both paths.
--
-- The signature gains exact_scan_limit, so this is a second function beside 0020's
-- 13-argument one, which an application of revision 20 through 23 still calls and
-- which stays exact. A later migration may drop it once no such instance runs.
-- compatible_from stays 9.
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
    candidate_limit integer,
    exact_scan_limit integer
) RETURNS TABLE(chunk_id uuid, memory_id uuid, candidate_rank bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    ROWS 200
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    SET plan_cache_mode TO 'force_custom_plan'
    SET hnsw.ef_search TO '200'
    AS $$
  WITH generations AS MATERIALIZED (
    SELECT coalesce(array_agg(generation.id), '{}'::uuid[]) AS ids
    FROM public.embedding_generations generation
    WHERE generation.embedding_provider = semantic_candidates.embedding_provider
      AND generation.embedding_model = semantic_candidates.embedding_model
      AND generation.embedding_revision = semantic_candidates.embedding_revision
      AND generation.embedding_dimensions = semantic_candidates.embedding_dimensions
      AND generation.status IN ('active'::public.embedding_generation_status,
                                'retiring'::public.embedding_generation_status)
  ),
  sized AS MATERIALIZED (
    -- Whether the Workspace has at least exact_scan_limit vectors; counting stops there.
    SELECT count(*) >= exact_scan_limit AS large
    FROM (
      SELECT 1
      FROM public.memory_chunk_embeddings candidate
      WHERE candidate.workspace_id = target_workspace_id
        AND candidate.generation_id = ANY ((SELECT ids FROM generations)::uuid[])
      LIMIT greatest(exact_scan_limit, 0)
    ) bounded
  ),
  visible_memories AS NOT MATERIALIZED (
    SELECT memory.id, memory.workspace_id, memory.updated_at
    FROM public.memories memory
    WHERE memory.workspace_id = target_workspace_id
      AND target_workspace_id = lore.current_workspace_id()
      AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
      AND (memory.scope = 'shared'::public.memory_scope OR memory.owner_user_id = lore.current_user_id())
      AND (scope_filter IS NULL OR memory.scope = scope_filter)
      AND (updated_after IS NULL OR memory.updated_at >= updated_after)
      AND (updated_before IS NULL OR memory.updated_at < updated_before)
      AND (metadata_filter IS NULL OR memory.metadata @> metadata_filter)
      AND NOT (memory.id = ANY(excluded_memory_ids))
  ),
  approximate AS MATERIALIZED (
    SELECT
      candidate.chunk_id,
      candidate.memory_id,
      memory.updated_at,
      candidate.embedding OPERATOR(public.<=>) query_embedding AS distance
    FROM public.memory_chunk_embeddings candidate
    JOIN visible_memories memory
      ON memory.id = candidate.memory_id
     AND memory.workspace_id = candidate.workspace_id
    WHERE (SELECT large FROM sized)
      AND query_embedding IS NOT NULL
      AND candidate.workspace_id = target_workspace_id
      AND candidate.generation_id = ANY ((SELECT ids FROM generations)::uuid[])
    -- With ties, so every row the walk finds at the last kept distance stays, and
    -- the order below chooses among them as the exact comparison would.
    ORDER BY candidate.embedding OPERATOR(public.<=>) query_embedding
    FETCH FIRST candidate_limit ROWS WITH TIES
  ),
  answered AS MATERIALIZED (
    SELECT (SELECT large FROM sized) AND (SELECT count(*) FROM approximate) >= candidate_limit
      AS approximately
  ),
  exact AS (
    SELECT embedded.chunk_id, embedded.memory_id, memory.updated_at, embedded.distance
    FROM (
      SELECT
        candidate.chunk_id,
        candidate.memory_id,
        candidate.workspace_id,
        -- Computed in the scan, after the generation filter. Adding zero changes no
        -- distance but keeps this ORDER BY away from the approximate HNSW index.
        (candidate.embedding OPERATOR(public.<=>) query_embedding) + 0.0::double precision AS distance
      FROM public.memory_chunk_embeddings candidate
      WHERE candidate.workspace_id = target_workspace_id
        AND candidate.generation_id = ANY ((SELECT ids FROM generations)::uuid[])
    ) embedded
    JOIN visible_memories memory
      ON memory.id = embedded.memory_id
     AND memory.workspace_id = embedded.workspace_id
    WHERE NOT (SELECT approximately FROM answered)
      AND query_embedding IS NOT NULL
      AND embedded.distance <= distance_threshold
    ORDER BY embedded.distance, memory.updated_at DESC
    FETCH FIRST candidate_limit ROWS WITH TIES
  ),
  nearest AS (
    -- Relaxed order means the walk's rows are only roughly sorted, but PostgreSQL 17
    -- and later may take a materialized CTE's ORDER BY as the order of its rows and
    -- skip or shorten the sort below. Adding zero makes the distance a new
    -- expression, so the rows are sorted again in full.
    SELECT approximate.chunk_id, approximate.memory_id, approximate.updated_at,
      approximate.distance + 0.0::double precision AS distance
    FROM approximate
    WHERE (SELECT approximately FROM answered)
      AND approximate.distance <= distance_threshold
    UNION ALL
    SELECT exact.chunk_id, exact.memory_id, exact.updated_at, exact.distance
    FROM exact
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
COMMENT ON FUNCTION lore.semantic_candidates(uuid, public.vector, text, text, text, integer, double precision, public.memory_scope, timestamp with time zone, timestamp with time zone, jsonb, uuid[], integer, integer) IS 'Semantic search candidates (ids and ranks) under the memories_select predicate: exact below exact_scan_limit vectors, HNSW at or above it with an exact fallback; the engine re-reads every candidate under RLS.';
REVOKE ALL ON FUNCTION lore.semantic_candidates(uuid, public.vector, text, text, text, integer, double precision, public.memory_scope, timestamp with time zone, timestamp with time zone, jsonb, uuid[], integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.semantic_candidates(uuid, public.vector, text, text, text, integer, double precision, public.memory_scope, timestamp with time zone, timestamp with time zone, jsonb, uuid[], integer, integer) TO lore_app;

-- Iterative index scans arrived in pgvector 0.8.0, and earlier versions reject the
-- settings, so they are set only where they exist. Without them a short walk falls
-- back to the exact comparison.
DO $$
BEGIN
  IF (SELECT string_to_array(extversion, '.')::integer[] >= ARRAY[0, 8, 0]
      FROM pg_catalog.pg_extension WHERE extname = 'vector') THEN
    ALTER FUNCTION lore.semantic_candidates(uuid, public.vector, text, text, text, integer, double precision, public.memory_scope, timestamp with time zone, timestamp with time zone, jsonb, uuid[], integer, integer)
      SET hnsw.iterative_scan TO relaxed_order;
    ALTER FUNCTION lore.semantic_candidates(uuid, public.vector, text, text, text, integer, double precision, public.memory_scope, timestamp with time zone, timestamp with time zone, jsonb, uuid[], integer, integer)
      SET hnsw.max_scan_tuples TO 40000;
  END IF;
END
$$;

UPDATE public.lore_system_state
SET schema_revision = 24, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
