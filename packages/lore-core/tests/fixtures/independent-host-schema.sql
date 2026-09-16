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
  embedding vector(8),
  embedding_provider text,
  embedding_model text,
  embedding_revision text,
  embedded_at timestamptz,
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
