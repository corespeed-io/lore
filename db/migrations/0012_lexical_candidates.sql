-- migrate:up
-- Schema revision 12: the lexical half of hybrid search moves into
-- lore.lexical_candidates, a SECURITY DEFINER function that indexes can serve.
--
-- Why a function. As lore_app, every Memory search runs under RLS, and Postgres
-- applies a policy's predicate before any query condition that is not leakproof and
-- never uses such a condition as an index condition. Full text `@@`, array `@>`, and
-- `LIKE` are not leakproof, so each lexical channel scanned every visible chunk of
-- the Workspace whatever indexes existed (the reason 0002 and 0003 dropped the chunk
-- GINs). This function runs as its owner, which owns the tables and is not subject to
-- their policies, so the Workspace-leading GIN indexes 0013 builds serve its probes.
--
-- What keeps it safe:
--   * Visibility is the memories_select policy's own predicate, read from the same
--     Actor settings: the Workspace must be lore.current_workspace_id(), the Actor
--     must pass lore.can_read_workspace (active Membership, or an active Agent read
--     grant), and a private Memory must belong to lore.current_user_id(). The
--     function takes no user or visibility argument. With no Actor context, or
--     another Workspace's id, it returns nothing.
--   * It returns ids and ranks, never content. The engine's search statement joins
--     every candidate back to memory_chunks and memories as lore_app, under RLS,
--     before fusing, so a mistake here can cost ranking quality but cannot reveal a
--     row (tests/server/lexical-candidates.test.ts replaces this function with one
--     that ignores visibility and shows search still hides every row it should).
--   * EXECUTE is granted to lore_app alone. search_path is pinned with pg_temp last
--     and every table is schema-qualified, so a caller's temporary table or view
--     named memories or memory_chunks cannot stand in for the real one (pg_temp is
--     otherwise searched first for relations, even in a SECURITY DEFINER function).
--
-- What it returns: exactly the candidates, with exactly the ranks, of the channels
-- the engine's search statement ran under RLS through revision 11 (the reference
-- statement in @corespeed/lore-core/testing): simple and English full text, relaxed
-- English terms (two or more), exact entity aliases, and CJK grams. Each channel
-- keeps its ORDER BY tie-breakers. The relaxed channel finds the chunks matching two
-- or more terms with one index probe (the OR of every pair of terms) rather than
-- reading every chunk that matches any one term, and the entity alias channel finds
-- its chunks with one overlap probe; both score each chunk once and read Memories in
-- score order only until their top candidates are known, which yields the set, the
-- score, and the order the old GROUP BY ... HAVING produced. The CJK channel tests
-- lore.extract_cjk_grams(content) @> ARRAY[gram], which holds exactly when content
-- LIKE '%' || gram || '%' did (see that function).
--
-- plan_cache_mode = force_custom_plan plans each call for its actual query: a word
-- in most chunks wants a different plan from a rare one.
--
-- compatible_from stays 9. This adds two functions and an extension; an application
-- of revision 9 through 11 uses none of them and loses nothing. CREATE FUNCTION
-- validates the body, which takes ACCESS SHARE on the tables it names and blocks no
-- read or write.

-- btree_gin gives plain columns such as workspace_id GIN operator classes, so 0013's
-- indexes can lead with the Workspace and a probe never collects another Workspace's
-- matches. It is a trusted contrib extension.
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;

-- The CJK channel's exact index terms: every 2- and 3-character window of every run
-- of CJK-range characters. A query gram (cjkLexicalGrams) is 2 or 3 code points of
-- the query side's run class (Han, Hiragana, Katakana, Hangul, and the word-internal
-- marks ー々ゝゞヽヾ), all inside the ranges below, so it occurs in content exactly
-- when it is one of these windows: content LIKE '%' || gram || '%' holds exactly when
-- lore.extract_cjk_grams(content) @> ARRAY[gram] does. The ranges are a superset of
-- the query side's class; an extra character only adds terms nobody searches for,
-- while a missing one would make a gram unfindable, so a test checks every code point
-- the query side accepts. Excluded on purpose, since no query gram contains them: CJK
-- punctuation and brackets (U+3000-3004, U+3008-3020, U+3030), the katakana middle
-- dot (U+30FB, which ends a run on the query side), vertical and small form variants
-- (U+FE10-FE6F), and fullwidth ASCII and halfwidth punctuation (U+FF00-FF65).
--
-- 0013 indexes this expression rather than a stored column: adding a STORED
-- generated column would rewrite memory_chunks under ACCESS EXCLUSIVE, blocking
-- every read and write of it for the length of the rewrite, while an expression
-- index builds CONCURRENTLY. GIN answers `@>` on arrays without a recheck, so a
-- search evaluates the expression only on a lossy bitmap page.
CREATE FUNCTION lore.extract_cjk_grams(input text) RETURNS text[]
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT coalesce(array_agg(DISTINCT gram ORDER BY gram), '{}'::text[])
  FROM (
    SELECT substr(run.characters[1], start, width) AS gram
    FROM regexp_matches(
      input,
      '[\u1100-\u11FF\u2E80-\u2FFF\u3005-\u3007\u3021-\u302F\u3031-\u30FA\u30FC-\uFE0F\uFE70-\uFEFF\uFF66-\U0010FFFF]{2,}',
      'g'
    ) AS run(characters)
    CROSS JOIN LATERAL generate_series(1, char_length(run.characters[1]) - 1) AS start
    CROSS JOIN (VALUES (2), (3)) AS widths(width)
    WHERE start + width - 1 <= char_length(run.characters[1])
  ) windows
$$;
COMMENT ON FUNCTION lore.extract_cjk_grams(text) IS 'Every 2- and 3-character window of each CJK-range run: the CJK lexical channel''s exact index terms.';
REVOKE ALL ON FUNCTION lore.extract_cjk_grams(text) FROM PUBLIC;
-- An index expression runs as the role that writes the row, and only lore_app inserts
-- chunks (nobody updates them since 0010, and a delete never evaluates it).
GRANT EXECUTE ON FUNCTION lore.extract_cjk_grams(text) TO lore_app;

CREATE FUNCTION lore.lexical_candidates(
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
    -- drives each channel from its chunk index and looks Memories up by key.
    SELECT memory.id, memory.workspace_id, memory.updated_at
    FROM public.memories memory
    WHERE memory.workspace_id = target_workspace_id
      AND target_workspace_id = lore.current_workspace_id()
      AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
      AND (memory.scope = 'shared'::memory_scope OR memory.owner_user_id = lore.current_user_id())
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
  english_query_terms AS MATERIALIZED (
    -- One row per distinct term query, numbered for the pairs below.
    SELECT row_number() OVER (ORDER BY grouped.query::text) AS ordinal, grouped.query, grouped.weight
    FROM (
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
    ) grouped
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
$$;
COMMENT ON FUNCTION lore.lexical_candidates(uuid, text, text[], text[], integer, public.memory_scope, timestamp with time zone, timestamp with time zone, jsonb, uuid[], integer) IS 'Lexical search candidates (ids and per-channel ranks) under the memories_select predicate; the engine re-reads every candidate under RLS.';
REVOKE ALL ON FUNCTION lore.lexical_candidates(uuid, text, text[], text[], integer, public.memory_scope, timestamp with time zone, timestamp with time zone, jsonb, uuid[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.lexical_candidates(uuid, text, text[], text[], integer, public.memory_scope, timestamp with time zone, timestamp with time zone, jsonb, uuid[], integer) TO lore_app;

UPDATE public.lore_system_state
SET schema_revision = 12, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
