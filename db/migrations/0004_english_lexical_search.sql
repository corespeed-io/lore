ALTER TABLE memory_chunks
  ADD COLUMN search_vector_english tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX memory_chunks_search_english_idx
  ON memory_chunks USING gin (search_vector_english);
