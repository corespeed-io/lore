-- migrate:up

ALTER TABLE memory_chunks
  ADD COLUMN search_vector_english tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX memory_chunks_search_english_idx
  ON memory_chunks USING gin (search_vector_english);

DO $$
BEGIN
  UPDATE lore_system_state
  SET schema_revision = 4, updated_at = now()
  WHERE singleton AND schema_revision = 3;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected Lore schema revision 3 before migration 0004';
  END IF;
END
$$;

-- migrate:down
