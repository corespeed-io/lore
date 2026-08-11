-- migrate:up

CREATE FUNCTION lore.extract_entity_aliases(input text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
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
$$;

ALTER TABLE memory_chunks
  ADD COLUMN entity_aliases text[]
  GENERATED ALWAYS AS (lore.extract_entity_aliases(content)) STORED;

CREATE INDEX memory_chunks_entity_aliases_idx
  ON memory_chunks USING gin (entity_aliases);

COMMENT ON FUNCTION lore.extract_entity_aliases(text) IS
  'Deterministic exact alias index terms; never an inferred Memory or authorization signal.';

REVOKE ALL ON FUNCTION lore.extract_entity_aliases(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.extract_entity_aliases(text) TO lore_app;

DO $$
BEGIN
  UPDATE lore_system_state
  SET schema_revision = 6, updated_at = now()
  WHERE singleton AND schema_revision = 5;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected Lore schema revision 5 before migration 0006';
  END IF;
END
$$;

-- migrate:down
