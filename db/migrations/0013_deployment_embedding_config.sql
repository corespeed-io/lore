DROP INDEX memory_chunks_embedding_cosine_idx;

ALTER TABLE memory_chunks
  DROP CONSTRAINT memory_chunks_embedding_state_check;

-- Existing vectors do not carry a complete provider/model/protocol identity and
-- cannot be compared safely with Lore v1 embeddings. Memory text remains the
-- source of truth and deterministic maintenance can regenerate these vectors.
UPDATE memory_chunks
SET embedding = NULL,
    embedding_model = NULL,
    embedded_at = NULL
WHERE embedding IS NOT NULL;

ALTER TABLE memory_chunks
  ALTER COLUMN embedding TYPE vector(1024) USING NULL::vector(1024),
  ADD COLUMN embedding_provider text,
  ADD COLUMN embedding_revision text;

ALTER TABLE memory_chunks
  ADD CONSTRAINT memory_chunks_embedding_state_check
  CHECK (
    (
      embedding IS NULL
      AND embedding_provider IS NULL
      AND embedding_model IS NULL
      AND embedding_revision IS NULL
      AND embedded_at IS NULL
    )
    OR (
      embedding IS NOT NULL
      AND btrim(embedding_provider) <> ''
      AND btrim(embedding_model) <> ''
      AND btrim(embedding_revision) <> ''
      AND vector_dims(embedding) = 1024
      AND embedded_at IS NOT NULL
    )
  );

CREATE INDEX memory_chunks_embedding_cosine_idx
  ON memory_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
