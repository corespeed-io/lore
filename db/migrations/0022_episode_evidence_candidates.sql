-- migrate:up
-- Schema revision 22: the channels of Episode evidence search move into
-- lore.episode_evidence_candidates, a SECURITY DEFINER function, as Memory search's
-- channels moved into lore.lexical_candidates (0012) and lore.semantic_candidates
-- (0020).
--
-- Why a function. Through revision 21 the engine ran the simple and English full
-- text, CJK, and semantic channels as lore_app on the tables, under RLS. RLS keeps a
-- non-leakproof operator (`@@`, `&&`) out of index conditions, so each lexical
-- channel read every visible evidence chunk of the Workspace, and each chunk, its
-- Observation, its Episode, and its vector passed a policy of its own. This function
-- runs as its owner, which is not subject to the policies, so 0023's
-- Workspace-leading GIN indexes serve the lexical probes, and the semantic channel
-- computes each distance in the scan.
--
-- What keeps it safe is what keeps the other candidate functions safe:
--   * Visibility is the episodes_select policy's own predicate (0021), read from the
--     same Actor settings: the Workspace must be lore.current_workspace_id(), the
--     Actor must pass lore.can_read_workspace, and a private Episode must belong to
--     lore.current_user_id(). Observations, evidence chunks, and vectors are visible
--     exactly when their Episode is. The function takes no user or visibility
--     argument; with no Actor context, or another Workspace's id, it returns nothing.
--   * It returns ids and ranks, never content or vectors. The engine joins every
--     candidate back to episode_evidence_chunks as lore_app, under RLS, before it
--     fuses them.
--   * EXECUTE is granted to lore_app alone. search_path is pinned with pg_temp last
--     and every relation, type, and operator is schema-qualified.
--
-- What it returns: exactly the candidates, with exactly the ranks, of the four
-- channels the engine's statement ran under RLS through revision 21 (the reference
-- statement in @corespeed/lore-core/testing), each with its ORDER BY tie-breakers.
-- The CJK channel keeps its count of matching grams, `strpos(normalize(content,
-- NFC), gram) > 0`; it finds its chunks with lore.extract_cjk_grams(normalize(content,
-- NFC)) && grams, which holds exactly when one of them matches (see
-- lore.extract_cjk_grams in 0012). The semantic channel's distance is
-- `(embedding <=> query) + 0`, which the planner cannot match to the HNSW index, so
-- the channel stays exact, as lore.semantic_candidates does.
--
-- compatible_from stays 9. This adds one function; an application of revision 9
-- through 21 does not use it and loses nothing. CREATE FUNCTION validates the body,
-- which takes ACCESS SHARE on the tables it names and blocks no read or write.
CREATE FUNCTION lore.episode_evidence_candidates(
    target_workspace_id uuid,
    search_query text,
    cjk_query_grams text[],
    query_embedding public.vector,
    embedding_provider text,
    embedding_model text,
    embedding_revision text,
    embedding_dimensions integer,
    distance_threshold double precision,
    index_revision text,
    scope_filter public.memory_scope,
    metadata_filter jsonb,
    group_metadata_key text,
    source_keys text[],
    candidate_limit integer
) RETURNS TABLE(channel text, chunk_id uuid, episode_id uuid, observation_id uuid, candidate_rank bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    ROWS 200
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    SET plan_cache_mode TO 'force_custom_plan'
    AS $$
  WITH visible_observations AS NOT MATERIALIZED (
    -- Inlined into each channel, so the planner drives each one from its own index
    -- and looks Observations up by key.
    SELECT observation.id, observation.workspace_id, observation.episode_id, observation.observed_at
    FROM public.observations observation
    JOIN public.episodes episode
      ON episode.id = observation.episode_id
     AND episode.workspace_id = observation.workspace_id
    WHERE observation.workspace_id = target_workspace_id
      AND target_workspace_id = lore.current_workspace_id()
      AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
      AND (episode.scope = 'shared'::public.memory_scope OR episode.owner_user_id = lore.current_user_id())
      AND (scope_filter IS NULL OR episode.scope = scope_filter)
      AND (metadata_filter IS NULL OR observation.metadata @> metadata_filter)
      AND (
        group_metadata_key IS NULL
        OR cardinality(source_keys) = 0
        OR observation.metadata->>group_metadata_key = ANY(source_keys)
      )
  ),
  simple_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      chunk.episode_id,
      chunk.observation_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', search_query), 32) DESC,
                 observation.observed_at DESC, chunk.observation_ordinal DESC,
                 chunk.chunk_ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM public.episode_evidence_chunks chunk
    JOIN visible_observations observation
      ON observation.id = chunk.observation_id
     AND observation.workspace_id = chunk.workspace_id
     AND observation.episode_id = chunk.episode_id
    WHERE chunk.workspace_id = target_workspace_id
      AND chunk.index_revision = episode_evidence_candidates.index_revision
      AND chunk.search_vector @@ websearch_to_tsquery('simple', search_query)
    ORDER BY ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', search_query), 32) DESC,
             observation.observed_at DESC, chunk.observation_ordinal DESC,
             chunk.chunk_ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  english_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      chunk.episode_id,
      chunk.observation_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english', search_query), 32) DESC,
                 observation.observed_at DESC, chunk.observation_ordinal DESC,
                 chunk.chunk_ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM public.episode_evidence_chunks chunk
    JOIN visible_observations observation
      ON observation.id = chunk.observation_id
     AND observation.workspace_id = chunk.workspace_id
     AND observation.episode_id = chunk.episode_id
    WHERE chunk.workspace_id = target_workspace_id
      AND chunk.index_revision = episode_evidence_candidates.index_revision
      AND chunk.search_vector_english @@ websearch_to_tsquery('english', search_query)
    ORDER BY ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english', search_query), 32) DESC,
             observation.observed_at DESC, chunk.observation_ordinal DESC,
             chunk.chunk_ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  cjk_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      chunk.episode_id,
      chunk.observation_id,
      row_number() OVER (
        ORDER BY matches.count DESC, observation.observed_at DESC,
                 chunk.observation_ordinal DESC, chunk.chunk_ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM public.episode_evidence_chunks chunk
    JOIN visible_observations observation
      ON observation.id = chunk.observation_id
     AND observation.workspace_id = chunk.workspace_id
     AND observation.episode_id = chunk.episode_id
    CROSS JOIN LATERAL (
      SELECT count(*) AS count
      FROM unnest(cjk_query_grams) AS gram
      WHERE strpos(normalize(chunk.content, NFC), gram) > 0
    ) matches
    WHERE chunk.workspace_id = target_workspace_id
      AND chunk.index_revision = episode_evidence_candidates.index_revision
      AND lore.extract_cjk_grams(normalize(chunk.content, NFC)) OPERATOR(pg_catalog.&&) cjk_query_grams
      AND matches.count > 0
    ORDER BY matches.count DESC, observation.observed_at DESC,
             chunk.observation_ordinal DESC, chunk.chunk_ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  semantic AS (
    SELECT
      chunk.id AS chunk_id,
      chunk.episode_id,
      chunk.observation_id,
      row_number() OVER (
        ORDER BY embedded.distance, observation.observed_at DESC,
                 chunk.observation_ordinal DESC, chunk.chunk_ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM (
      SELECT
        candidate.chunk_id,
        candidate.workspace_id,
        -- Computed in the scan, after the generation filter. Adding zero changes no
        -- distance but keeps the ORDER BY away from the approximate HNSW index.
        (candidate.embedding OPERATOR(public.<=>) query_embedding) + 0.0::double precision AS distance
      FROM public.episode_evidence_chunk_embeddings candidate
      WHERE candidate.workspace_id = target_workspace_id
        AND candidate.generation_id = ANY (ARRAY(
          SELECT generation.id
          FROM public.embedding_generations generation
          WHERE generation.embedding_provider = episode_evidence_candidates.embedding_provider
            AND generation.embedding_model = episode_evidence_candidates.embedding_model
            AND generation.embedding_revision = episode_evidence_candidates.embedding_revision
            AND generation.embedding_dimensions = episode_evidence_candidates.embedding_dimensions
            AND generation.status IN ('active'::public.embedding_generation_status,
                                      'retiring'::public.embedding_generation_status)
        ))
    ) embedded
    JOIN public.episode_evidence_chunks chunk
      ON chunk.id = embedded.chunk_id
     AND chunk.workspace_id = embedded.workspace_id
    JOIN visible_observations observation
      ON observation.id = chunk.observation_id
     AND observation.workspace_id = chunk.workspace_id
     AND observation.episode_id = chunk.episode_id
    WHERE query_embedding IS NOT NULL
      AND chunk.index_revision = episode_evidence_candidates.index_revision
      AND embedded.distance <= distance_threshold
    ORDER BY embedded.distance, observation.observed_at DESC,
             chunk.observation_ordinal DESC, chunk.chunk_ordinal DESC, chunk.id
    LIMIT candidate_limit
  )
  SELECT 'simple', chunk_id, episode_id, observation_id, candidate_rank FROM simple_lexical
  UNION ALL
  SELECT 'english', chunk_id, episode_id, observation_id, candidate_rank FROM english_lexical
  UNION ALL
  SELECT 'cjk', chunk_id, episode_id, observation_id, candidate_rank FROM cjk_lexical
  UNION ALL
  SELECT 'semantic', chunk_id, episode_id, observation_id, candidate_rank FROM semantic
$$;
COMMENT ON FUNCTION lore.episode_evidence_candidates(uuid, text, text[], public.vector, text, text, text, integer, double precision, text, public.memory_scope, jsonb, text, text[], integer) IS 'Episode evidence search candidates (ids and per-channel ranks) under the episodes_select predicate; the engine re-reads every candidate under RLS.';
REVOKE ALL ON FUNCTION lore.episode_evidence_candidates(uuid, text, text[], public.vector, text, text, text, integer, double precision, text, public.memory_scope, jsonb, text, text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.episode_evidence_candidates(uuid, text, text[], public.vector, text, text, text, integer, double precision, text, public.memory_scope, jsonb, text, text[], integer) TO lore_app;

UPDATE public.lore_system_state
SET schema_revision = 22, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
