-- Minimal independent host schema: memory storage only, with no identity or
-- authorization tables/functions. Column names follow the engine's SQL contract.
CREATE EXTENSION vector;
CREATE SCHEMA lore;
CREATE TYPE memory_scope AS ENUM ('shared', 'private');

CREATE FUNCTION lore.extract_entity_aliases(input text) RETURNS text[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $_$
  WITH raw_aliases(raw_alias) AS (
    SELECT match[1]
    FROM regexp_matches(
      input,
      '"([^"[:cntrl:]]{2,128})"',
      'g'
    ) AS match
    UNION ALL
    SELECT match[1]
    FROM regexp_matches(
      input,
      '([[:upper:]][[:alnum:]_.''’:-]*(?:[[:space:]]+(?:(?:of|the|and|for|de|da|del|van|von|la|le)[[:space:]]+)?[[:upper:]][[:alnum:]_.''’:-]*)*)',
      'g'
    ) AS match
    UNION ALL
    SELECT match[1]
    FROM regexp_matches(
      input,
      '([[:upper:]][[:alnum:]_.''’:-]+)',
      'g'
    ) AS match
    UNION ALL
    SELECT match[1]
    FROM regexp_matches(
      input,
      '([[:alnum:]_./:#-]*[[:digit:]][[:alnum:]_./:#-]*)',
      'g'
    ) AS match
  ),
  normalized(alias) AS (
    SELECT lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(btrim(raw_alias), '[[:space:]]+', ' ', 'g'),
          '^[^[:alnum:]]+',
          ''
        ),
        '[^[:alnum:]]+$',
        ''
      )
    )
    FROM raw_aliases
  ),
  bounded AS (
    SELECT
      alias,
      cardinality(regexp_split_to_array(alias, '[[:space:]]+')) AS word_count,
      char_length(alias) AS alias_length
    FROM normalized
    WHERE char_length(alias) BETWEEN 2 AND 128
      AND alias ~ '[[:alpha:]]'
      AND alias NOT IN (
        'a', 'an', 'are', 'at', 'can', 'could', 'did', 'do', 'does', 'for',
        'from', 'had', 'has', 'have', 'how', 'in', 'is', 'may', 'might', 'of',
        'on', 'should', 'that', 'the', 'these', 'this', 'those', 'to', 'was',
        'were', 'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why',
        'will', 'would'
      )
    GROUP BY alias
    ORDER BY
      cardinality(regexp_split_to_array(alias, '[[:space:]]+')) DESC,
      char_length(alias) DESC,
      alias
    LIMIT 64
  )
  SELECT COALESCE(
    array_agg(alias ORDER BY word_count DESC, alias_length DESC, alias),
    ARRAY[]::text[]
  )
  FROM bounded
$_$;

CREATE TABLE memories (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  created_by_agent_id uuid,
  scope memory_scope NOT NULL,
  title text,
  gloss text,
  occurred_at timestamptz,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_chunks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  content text NOT NULL,
  chunking_revision text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  search_vector_english tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  entity_aliases text[] GENERATED ALWAYS AS (lore.extract_entity_aliases(content)) STORED
);

CREATE TABLE embedding_generations (
  id uuid PRIMARY KEY,
  embedding_provider text NOT NULL,
  embedding_model text NOT NULL,
  embedding_revision text NOT NULL,
  embedding_dimensions integer NOT NULL,
  status text NOT NULL
);

CREATE TABLE memory_chunk_embeddings (
  generation_id uuid NOT NULL REFERENCES embedding_generations(id),
  chunk_id uuid NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  embedding vector(8) NOT NULL,
  PRIMARY KEY (generation_id, chunk_id)
);

CREATE TABLE memory_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  source_memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind text NOT NULL,
  weight real NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source_memory_id, target_memory_id, kind)
);

-- The lexical channels, as the engine asks for them. This host has no access policy
-- beyond the storage partition, so its body is the reference channels over the
-- partition (referenceLexicalCandidates in ../../src/testing.ts) with no index work.
CREATE FUNCTION lore.lexical_candidates(
    target_workspace_id uuid,
    search_query text,
    relaxed_terms text[],
    cjk_query_grams text[],
    alias_limit integer,
    scope_filter memory_scope,
    updated_after timestamptz,
    updated_before timestamptz,
    metadata_filter jsonb,
    excluded_memory_ids uuid[],
    candidate_limit integer
) RETURNS TABLE(channel text, chunk_id uuid, memory_id uuid, candidate_rank bigint)
    LANGUAGE sql STABLE
    AS $$
  WITH visible_memories AS (
    SELECT memory.id, memory.workspace_id, memory.updated_at, memory.title, memory.gloss
    FROM memories memory
    WHERE memory.workspace_id = target_workspace_id
      AND (scope_filter IS NULL OR memory.scope = scope_filter)
      AND (updated_after IS NULL OR memory.updated_at >= updated_after)
      AND (updated_before IS NULL OR memory.updated_at < updated_before)
      AND (metadata_filter IS NULL OR memory.metadata @> metadata_filter)
      AND NOT (memory.id = ANY(excluded_memory_ids))
  ),
  simple_lexical AS (
    SELECT chunk.id AS chunk_id, memory.id AS memory_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', search_query), 32) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM memory_chunks chunk
    JOIN visible_memories memory ON memory.id = chunk.memory_id
    WHERE chunk.search_vector @@ websearch_to_tsquery('simple', search_query)
    ORDER BY ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', search_query), 32) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  english_lexical AS (
    SELECT chunk.id AS chunk_id, memory.id AS memory_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english', search_query), 32) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM memory_chunks chunk
    JOIN visible_memories memory ON memory.id = chunk.memory_id
    WHERE chunk.search_vector_english @@ websearch_to_tsquery('english', search_query)
    ORDER BY ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english', search_query), 32) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  english_query_terms AS MATERIALIZED (
    SELECT plainto_tsquery('english', term) AS query,
      max(CASE
            WHEN term ~ '^[[:upper:]][[:lower:]]' THEN 4.0
            WHEN term ~ '[[:digit:]]' THEN 3.0
            WHEN char_length(term) >= 10 THEN 1.5
            ELSE 1.0
          END) AS weight
    FROM unnest(relaxed_terms) AS term
    WHERE numnode(plainto_tsquery('english', term)) > 0
    GROUP BY plainto_tsquery('english', term)
  ),
  relaxed_english_lexical AS (
    SELECT chunk.id AS chunk_id, memory.id AS memory_id,
      row_number() OVER (
        ORDER BY sum(ts_rank_cd(chunk.search_vector_english, term.query, 32) * term.weight) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM memory_chunks chunk
    JOIN visible_memories memory ON memory.id = chunk.memory_id
    JOIN english_query_terms term ON chunk.search_vector_english @@ term.query
    GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
    HAVING count(*) >= 2
    ORDER BY sum(ts_rank_cd(chunk.search_vector_english, term.query, 32) * term.weight) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  query_entity_aliases AS MATERIALIZED (
    SELECT alias
    FROM unnest(lore.extract_entity_aliases(search_query)) WITH ORDINALITY AS extracted(alias, ordinal)
    ORDER BY ordinal
    LIMIT alias_limit
  ),
  entity_alias_lexical AS (
    SELECT chunk.id AS chunk_id, memory.id AS memory_id,
      row_number() OVER (
        ORDER BY count(*) DESC, max(char_length(query_alias.alias)) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM query_entity_aliases query_alias
    JOIN memory_chunks chunk ON chunk.entity_aliases @> ARRAY[query_alias.alias]::text[]
    JOIN visible_memories memory ON memory.id = chunk.memory_id
    GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
    ORDER BY count(*) DESC, max(char_length(query_alias.alias)) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  cjk_lexical AS (
    SELECT chunk.id AS chunk_id, memory.id AS memory_id,
      row_number() OVER (
        ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM unnest(cjk_query_grams) AS gram(gram)
    JOIN memory_chunks chunk ON chunk.content LIKE ('%' || gram.gram || '%')
    JOIN visible_memories memory ON memory.id = chunk.memory_id
    GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
    HAVING count(*) >= least(2, cardinality(cjk_query_grams))
    ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  name_simple_lexical AS (
    SELECT chunk.id AS chunk_id, memory.id AS memory_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(to_tsvector('simple', concat_ws(' ', memory.title, memory.gloss)), websearch_to_tsquery('simple', search_query), 32) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM visible_memories memory
    JOIN memory_chunks chunk ON chunk.memory_id = memory.id AND chunk.ordinal = 0
    WHERE to_tsvector('simple', concat_ws(' ', memory.title, memory.gloss)) @@ websearch_to_tsquery('simple', search_query)
    ORDER BY ts_rank_cd(to_tsvector('simple', concat_ws(' ', memory.title, memory.gloss)), websearch_to_tsquery('simple', search_query), 32) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  name_english_lexical AS (
    SELECT chunk.id AS chunk_id, memory.id AS memory_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(to_tsvector('english', concat_ws(' ', memory.title, memory.gloss)), websearch_to_tsquery('english', search_query), 32) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM visible_memories memory
    JOIN memory_chunks chunk ON chunk.memory_id = memory.id AND chunk.ordinal = 0
    WHERE to_tsvector('english', concat_ws(' ', memory.title, memory.gloss)) @@ websearch_to_tsquery('english', search_query)
    ORDER BY ts_rank_cd(to_tsvector('english', concat_ws(' ', memory.title, memory.gloss)), websearch_to_tsquery('english', search_query), 32) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  name_relaxed_english_lexical AS (
    SELECT chunk.id AS chunk_id, memory.id AS memory_id,
      row_number() OVER (
        ORDER BY sum(ts_rank_cd(to_tsvector('english', concat_ws(' ', memory.title, memory.gloss)), term.query, 32) * term.weight) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM visible_memories memory
    JOIN memory_chunks chunk ON chunk.memory_id = memory.id AND chunk.ordinal = 0
    JOIN english_query_terms term ON to_tsvector('english', concat_ws(' ', memory.title, memory.gloss)) @@ term.query
    GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
    HAVING count(*) >= 2
    ORDER BY sum(ts_rank_cd(to_tsvector('english', concat_ws(' ', memory.title, memory.gloss)), term.query, 32) * term.weight) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  name_cjk_lexical AS (
    SELECT chunk.id AS chunk_id, memory.id AS memory_id,
      row_number() OVER (
        ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM unnest(cjk_query_grams) AS gram(gram)
    JOIN visible_memories memory ON concat_ws(' ', memory.title, memory.gloss) LIKE ('%' || gram.gram || '%')
    JOIN memory_chunks chunk ON chunk.memory_id = memory.id AND chunk.ordinal = 0
    GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
    HAVING count(*) >= least(2, cardinality(cjk_query_grams))
    ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  )
  SELECT 'simple', chunk_id, memory_id, candidate_rank FROM simple_lexical
  UNION ALL SELECT 'english', chunk_id, memory_id, candidate_rank FROM english_lexical
  UNION ALL SELECT 'relaxed_english', chunk_id, memory_id, candidate_rank FROM relaxed_english_lexical
  UNION ALL SELECT 'entity_alias', chunk_id, memory_id, candidate_rank FROM entity_alias_lexical
  UNION ALL SELECT 'cjk', chunk_id, memory_id, candidate_rank FROM cjk_lexical
  UNION ALL SELECT 'name_simple', chunk_id, memory_id, candidate_rank FROM name_simple_lexical
  UNION ALL SELECT 'name_english', chunk_id, memory_id, candidate_rank FROM name_english_lexical
  UNION ALL SELECT 'name_relaxed_english', chunk_id, memory_id, candidate_rank FROM name_relaxed_english_lexical
  UNION ALL SELECT 'name_cjk', chunk_id, memory_id, candidate_rank FROM name_cjk_lexical
$$;

-- The semantic channel, as the engine asks for it: the reference channel over the
-- partition (referenceSemanticCandidates in ../../src/testing.ts), with no access
-- policy and no index work. It is always exact, so it ignores exact_scan_limit.
CREATE FUNCTION lore.semantic_candidates(
    target_workspace_id uuid,
    query_embedding vector,
    embedding_provider text,
    embedding_model text,
    embedding_revision text,
    embedding_dimensions integer,
    distance_threshold double precision,
    scope_filter memory_scope,
    updated_after timestamptz,
    updated_before timestamptz,
    metadata_filter jsonb,
    excluded_memory_ids uuid[],
    candidate_limit integer,
    exact_scan_limit integer
) RETURNS TABLE(chunk_id uuid, memory_id uuid, candidate_rank bigint)
    LANGUAGE sql STABLE
    AS $$
  WITH active_semantic_chunks AS MATERIALIZED (
    SELECT chunk.id, chunk.memory_id, chunk.ordinal,
      memory.updated_at AS memory_updated_at, embedded.embedding
    FROM memory_chunks chunk
    JOIN memories memory ON memory.id = chunk.memory_id
    JOIN memory_chunk_embeddings embedded ON embedded.chunk_id = chunk.id
    JOIN embedding_generations generation ON generation.id = embedded.generation_id
    WHERE chunk.workspace_id = target_workspace_id
      AND generation.embedding_provider = semantic_candidates.embedding_provider
      AND generation.embedding_model = semantic_candidates.embedding_model
      AND generation.embedding_revision = semantic_candidates.embedding_revision
      AND generation.embedding_dimensions = semantic_candidates.embedding_dimensions
      AND generation.status IN ('active', 'retiring')
      AND (scope_filter IS NULL OR memory.scope = scope_filter)
      AND (updated_after IS NULL OR memory.updated_at >= updated_after)
      AND (updated_before IS NULL OR memory.updated_at < updated_before)
      AND (metadata_filter IS NULL OR memory.metadata @> metadata_filter)
      AND NOT (memory.id = ANY(excluded_memory_ids))
  )
  SELECT chunk.id, chunk.memory_id,
    row_number() OVER (
      ORDER BY chunk.embedding <=> query_embedding,
               chunk.memory_updated_at DESC, chunk.ordinal DESC, chunk.id
    )
  FROM active_semantic_chunks chunk
  WHERE (chunk.embedding <=> query_embedding) <= distance_threshold
  ORDER BY chunk.embedding <=> query_embedding,
           chunk.memory_updated_at DESC, chunk.ordinal DESC, chunk.id
  LIMIT candidate_limit
$$;
