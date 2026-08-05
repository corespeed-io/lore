CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE memory_chunks
  ADD COLUMN embedding vector,
  ADD COLUMN embedding_model text,
  ADD COLUMN embedded_at timestamptz;

ALTER TABLE memory_chunks
  ADD CONSTRAINT memory_chunks_embedding_state_check
  CHECK (
    (embedding IS NULL AND embedding_model IS NULL AND embedded_at IS NULL)
    OR (embedding IS NOT NULL AND embedding_model IS NOT NULL AND embedded_at IS NOT NULL)
  );
