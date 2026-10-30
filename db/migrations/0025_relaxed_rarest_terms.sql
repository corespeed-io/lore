-- migrate:up
-- Schema revision 25: the relaxed English channel of lore.lexical_candidates uses at
-- most six terms, a long query's rarest.
--
-- Why. The relaxed channel finds chunks that match two or more query terms, with one
-- index probe made of every pair of terms, and then scores each match. A long
-- question has many ordinary terms: 17 made 136 pairs, the probe alone took about
-- 0.19 s, and scoring the thousands of chunks that shared any two of them took about
-- 0.5 s more. On 500 LongMemEval-S questions over 48,000 real chunks, this channel
-- was most of the lexical time.
--
-- The rule. A query of six or fewer terms is answered exactly as through revision
-- 24. A longer one first drops the terms that no visible chunk and no visible name
-- matches, which changes no answer. If more than six remain, it keeps six: those
-- found in the fewest chunks of a fixed sample, the first 1,000 visible chunks of
-- the searched Memories in (memory_id, ordinal) order, then the heavier, then by
-- text. The probe and the score use only those six. The name channel that matches two or more terms uses the same six.
-- Only visible chunks are sampled, so another User's private Memory and another
-- Workspace never decide which terms are kept. referenceLexicalCandidates in
-- @corespeed/lore-core/testing states the same rule.
--
-- compatible_from stays 9: the signature is unchanged, and an older application
-- fuses whatever candidates the function answers.
CREATE OR REPLACE FUNCTION lore.lexical_candidates(
    target_workspace_id uuid,
    search_query text,
    relaxed_terms text[],
    cjk_query_grams text[],
    alias_limit integer,
    scope_filter public.memory_scope,
    updated_after timestamp with time zone,
    updated_before timestamp with time zone,
    metadata_filter jsonb,
    excluded_memory_ids uuid[],
    candidate_limit integer
) RETURNS TABLE(channel text, chunk_id uuid, memory_id uuid, candidate_rank bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    ROWS 200
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    SET plan_cache_mode TO 'force_custom_plan'
    AS $$
  WITH visible_memories AS NOT MATERIALIZED (
    -- Inlined into each channel (a CTE named more than once is otherwise
    -- materialized: every visible Memory, read once per search), so the planner
    -- drives each channel from its own index and looks Memories up by key.
    SELECT memory.id, memory.workspace_id, memory.updated_at, memory.title, memory.gloss
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
  simple_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', search_query), 32) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM public.memory_chunks chunk
    JOIN visible_memories memory
      ON memory.id = chunk.memory_id
     AND memory.workspace_id = chunk.workspace_id
    WHERE chunk.workspace_id = target_workspace_id
      AND chunk.search_vector @@ websearch_to_tsquery('simple', search_query)
    ORDER BY ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', search_query), 32) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  english_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english', search_query), 32) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM public.memory_chunks chunk
    JOIN visible_memories memory
      ON memory.id = chunk.memory_id
     AND memory.workspace_id = chunk.workspace_id
    WHERE chunk.workspace_id = target_workspace_id
      AND chunk.search_vector_english @@ websearch_to_tsquery('english', search_query)
    ORDER BY ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english', search_query), 32) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  all_english_query_terms AS MATERIALIZED (
    -- One row per distinct term query.
    SELECT
      plainto_tsquery('english', term) AS query,
      max(
        CASE
          WHEN term ~ '^[[:upper:]][[:lower:]]' THEN 4.0
          WHEN term ~ '[[:digit:]]' THEN 3.0
          WHEN char_length(term) >= 10 THEN 1.5
          ELSE 1.0
        END
      ) AS weight
    FROM unnest(relaxed_terms) AS term
    WHERE numnode(plainto_tsquery('english', term)) > 0
    GROUP BY plainto_tsquery('english', term)
  ),
  present_english_query_terms AS MATERIALIZED (
    -- A query of more than six terms first drops the terms that no visible chunk and
    -- no visible name matches: they cannot match here, so dropping them changes no
    -- answer, and they never take the place of a term that can.
    SELECT term.query, term.weight
    FROM all_english_query_terms term
    WHERE (SELECT count(*) FROM all_english_query_terms) <= 6
       OR EXISTS (
         SELECT 1
         FROM public.memory_chunks chunk
         JOIN visible_memories memory
           ON memory.id = chunk.memory_id
          AND memory.workspace_id = chunk.workspace_id
         WHERE chunk.workspace_id = target_workspace_id
           AND chunk.search_vector_english @@ term.query
       )
       OR EXISTS (
         SELECT 1
         FROM visible_memories memory
         WHERE to_tsvector('english', lore.memory_name_text(memory.title, memory.gloss)) @@ term.query
       )
  ),
  relaxed_term_sample AS MATERIALIZED (
    -- Read only when more than six present terms remain: the first 1,000 chunks, in
    -- index order, of the Memories this caller may search. Only visible chunks count,
    -- so no other User's private Memory and no other Workspace decides which terms
    -- are rare.
    SELECT chunk.search_vector_english || ''::tsvector AS english
    FROM public.memory_chunks chunk
    JOIN visible_memories memory
      ON memory.id = chunk.memory_id
     AND memory.workspace_id = chunk.workspace_id
    WHERE (SELECT count(*) FROM present_english_query_terms) > 6
      AND chunk.workspace_id = target_workspace_id
    ORDER BY chunk.memory_id, chunk.ordinal
    LIMIT 1000
  ),
  english_query_terms AS MATERIALIZED (
    -- At most six terms, numbered for the pairs below: the six present terms found in
    -- the fewest sampled chunks (then the heavier, then by text). Six terms make at
    -- most 15 pairs, where 17 made 136 and matched most of a Workspace.
    SELECT row_number() OVER (ORDER BY kept.query::text) AS ordinal, kept.query, kept.weight
    FROM (
      SELECT term.query, term.weight
      FROM present_english_query_terms term
      ORDER BY
        (SELECT count(*) FROM relaxed_term_sample sample WHERE sample.english @@ term.query),
        term.weight DESC,
        term.query::text
      LIMIT 6
    ) kept
  ),
  relaxed_english_query AS MATERIALIZED (
    -- two_terms matches a chunk exactly when two or more term queries do: the OR of
    -- every pair's AND. It is NULL with fewer than two terms, which matches nothing.
    -- One GIN probe answers it, where counting each term's matches would read every
    -- chunk that matches any one term.
    SELECT
      (SELECT array_agg(term.query ORDER BY term.ordinal) FROM english_query_terms term) AS queries,
      (SELECT array_agg(term.weight ORDER BY term.ordinal) FROM english_query_terms term) AS weights,
      (
        SELECT string_agg(format('(%s) & (%s)', first.query, second.query), ' | ')::tsquery
        FROM english_query_terms first
        JOIN english_query_terms second ON first.ordinal < second.ordinal
      ) AS two_terms
  ),
  relaxed_english_scored AS (
    -- Each matched chunk is scored once over the term arrays, and scored chunks come
    -- out best first, so the join below looks up Memories only until the top
    -- candidate_limit visible ones (and their ties) are known. A chunk's tsvector is
    -- often stored out of line, and every reference to the column fetches it again,
    -- so the vector is read into memory once (concatenating the empty tsvector copies
    -- it unchanged; OFFSET 0 keeps the planner from substituting the expression back
    -- into each reference) and scored from there.
    SELECT
      chunk.id AS chunk_id,
      chunk.memory_id,
      chunk.ordinal,
      (
        SELECT sum(ts_rank_cd(vector.english, term.query, 32) * term.weight)
        FROM unnest(terms.queries, terms.weights) AS term(query, weight)
        WHERE vector.english @@ term.query
      ) AS score
    FROM relaxed_english_query terms
    JOIN public.memory_chunks chunk
      ON chunk.workspace_id = target_workspace_id
     AND chunk.search_vector_english @@ terms.two_terms
    CROSS JOIN LATERAL (SELECT chunk.search_vector_english || ''::tsvector AS english OFFSET 0) vector
    ORDER BY 4 DESC
  ),
  relaxed_english_lexical AS (
    SELECT
      scored.chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY scored.score DESC, memory.updated_at DESC, scored.ordinal DESC, scored.chunk_id
      ) AS candidate_rank
    FROM relaxed_english_scored scored
    JOIN visible_memories memory
      ON memory.id = scored.memory_id
     AND memory.workspace_id = target_workspace_id
    ORDER BY scored.score DESC, memory.updated_at DESC, scored.ordinal DESC, scored.chunk_id
    LIMIT candidate_limit
  ),
  query_entity_aliases AS MATERIALIZED (
    SELECT array_agg(limited.alias ORDER BY limited.ordinal) AS aliases
    FROM (
      SELECT extracted.alias, extracted.ordinal
      FROM unnest(lore.extract_entity_aliases(search_query)) WITH ORDINALITY AS extracted(alias, ordinal)
      ORDER BY extracted.ordinal
      LIMIT alias_limit
    ) limited
  ),
  entity_alias_scored AS (
    -- One GIN probe finds the chunks holding any query alias (NULL aliases, under an
    -- alias_limit of 0, match nothing); each is counted once from its own alias array
    -- (`@>` on one element is `= ANY`), and counted chunks come out best first so
    -- Memories are looked up only until the top candidates are known.
    SELECT
      chunk.id AS chunk_id,
      chunk.memory_id,
      chunk.ordinal,
      matched.match_count,
      matched.specificity
    FROM query_entity_aliases query
    JOIN public.memory_chunks chunk
      ON chunk.workspace_id = target_workspace_id
     AND chunk.entity_aliases && query.aliases
    CROSS JOIN LATERAL (
      SELECT count(*) AS match_count, max(char_length(alias)) AS specificity
      FROM unnest(query.aliases) AS alias
      WHERE alias = ANY(chunk.entity_aliases)
    ) matched
    ORDER BY matched.match_count DESC, matched.specificity DESC
  ),
  entity_alias_lexical AS (
    SELECT
      scored.chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY scored.match_count DESC, scored.specificity DESC,
                 memory.updated_at DESC, scored.ordinal DESC, scored.chunk_id
      ) AS candidate_rank
    FROM entity_alias_scored scored
    JOIN visible_memories memory
      ON memory.id = scored.memory_id
     AND memory.workspace_id = target_workspace_id
    ORDER BY scored.match_count DESC, scored.specificity DESC,
             memory.updated_at DESC, scored.ordinal DESC, scored.chunk_id
    LIMIT candidate_limit
  ),
  cjk_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM unnest(cjk_query_grams) AS gram(gram)
    JOIN public.memory_chunks chunk
      ON chunk.workspace_id = target_workspace_id
     AND lore.extract_cjk_grams(chunk.content) @> ARRAY[gram.gram]
    JOIN visible_memories memory
      ON memory.id = chunk.memory_id
     AND memory.workspace_id = chunk.workspace_id
    GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
    HAVING count(*) >= least(2, cardinality(cjk_query_grams))
    ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  -- The name channels. Each probes lore.memory_name_text(title, gloss) through
  -- 0017's Workspace-leading index on the same expression, then joins the Memory's
  -- first chunk by its (memory_id, ordinal) key. A Memory with neither matches nothing.
  name_simple_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(to_tsvector('simple', lore.memory_name_text(memory.title, memory.gloss)), websearch_to_tsquery('simple', search_query), 32) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM visible_memories memory
    JOIN public.memory_chunks chunk
      ON chunk.memory_id = memory.id
     AND chunk.ordinal = 0
     AND chunk.workspace_id = memory.workspace_id
    WHERE to_tsvector('simple', lore.memory_name_text(memory.title, memory.gloss)) @@ websearch_to_tsquery('simple', search_query)
    ORDER BY ts_rank_cd(to_tsvector('simple', lore.memory_name_text(memory.title, memory.gloss)), websearch_to_tsquery('simple', search_query), 32) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  name_english_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(to_tsvector('english', lore.memory_name_text(memory.title, memory.gloss)), websearch_to_tsquery('english', search_query), 32) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM visible_memories memory
    JOIN public.memory_chunks chunk
      ON chunk.memory_id = memory.id
     AND chunk.ordinal = 0
     AND chunk.workspace_id = memory.workspace_id
    WHERE to_tsvector('english', lore.memory_name_text(memory.title, memory.gloss)) @@ websearch_to_tsquery('english', search_query)
    ORDER BY ts_rank_cd(to_tsvector('english', lore.memory_name_text(memory.title, memory.gloss)), websearch_to_tsquery('english', search_query), 32) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  name_relaxed_english_lexical AS (
    -- The relaxed channel's pair query over the names; they are short, so they are
    -- scored where they matched rather than read once ahead.
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY scored.score DESC, memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM relaxed_english_query terms
    JOIN visible_memories memory
      ON to_tsvector('english', lore.memory_name_text(memory.title, memory.gloss)) @@ terms.two_terms
    CROSS JOIN LATERAL (
      SELECT sum(ts_rank_cd(to_tsvector('english', lore.memory_name_text(memory.title, memory.gloss)), term.query, 32) * term.weight) AS score
      FROM unnest(terms.queries, terms.weights) AS term(query, weight)
      WHERE to_tsvector('english', lore.memory_name_text(memory.title, memory.gloss)) @@ term.query
    ) scored
    JOIN public.memory_chunks chunk
      ON chunk.memory_id = memory.id
     AND chunk.ordinal = 0
     AND chunk.workspace_id = memory.workspace_id
    ORDER BY scored.score DESC, memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  name_cjk_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM unnest(cjk_query_grams) AS gram(gram)
    JOIN visible_memories memory
      ON lore.extract_cjk_grams(lore.memory_name_text(memory.title, memory.gloss)) @> ARRAY[gram.gram]
    JOIN public.memory_chunks chunk
      ON chunk.memory_id = memory.id
     AND chunk.ordinal = 0
     AND chunk.workspace_id = memory.workspace_id
    GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
    HAVING count(*) >= least(2, cardinality(cjk_query_grams))
    ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  )
  SELECT 'simple', chunk_id, memory_id, candidate_rank FROM simple_lexical
  UNION ALL
  SELECT 'english', chunk_id, memory_id, candidate_rank FROM english_lexical
  UNION ALL
  SELECT 'relaxed_english', chunk_id, memory_id, candidate_rank FROM relaxed_english_lexical
  UNION ALL
  SELECT 'entity_alias', chunk_id, memory_id, candidate_rank FROM entity_alias_lexical
  UNION ALL
  SELECT 'cjk', chunk_id, memory_id, candidate_rank FROM cjk_lexical
  UNION ALL
  SELECT 'name_simple', chunk_id, memory_id, candidate_rank FROM name_simple_lexical
  UNION ALL
  SELECT 'name_english', chunk_id, memory_id, candidate_rank FROM name_english_lexical
  UNION ALL
  SELECT 'name_relaxed_english', chunk_id, memory_id, candidate_rank FROM name_relaxed_english_lexical
  UNION ALL
  SELECT 'name_cjk', chunk_id, memory_id, candidate_rank FROM name_cjk_lexical
$$;

COMMENT ON FUNCTION lore.lexical_candidates(uuid, text, text[], text[], integer, public.memory_scope, timestamp with time zone, timestamp with time zone, jsonb, uuid[], integer) IS 'Lexical search candidates (ids and per-channel ranks) under the memories_select predicate; the engine re-reads every candidate under RLS. The relaxed channels use at most six terms, a long query''s rarest in a fixed visible sample.';

UPDATE public.lore_system_state
SET schema_revision = 25, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
