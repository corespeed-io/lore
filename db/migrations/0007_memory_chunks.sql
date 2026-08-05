CREATE TABLE memory_chunks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  content text NOT NULL CHECK (btrim(content) <> ''),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (memory_id, ordinal),
  FOREIGN KEY (workspace_id, memory_id)
    REFERENCES memories(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX memory_chunks_workspace_memory_idx ON memory_chunks (workspace_id, memory_id);
CREATE INDEX memory_chunks_search_idx ON memory_chunks USING gin (search_vector);

ALTER TABLE memory_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY memory_chunks_select ON memory_chunks
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM memories memory
      WHERE memory.id = memory_chunks.memory_id
        AND memory.workspace_id = memory_chunks.workspace_id
        AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)
    )
  );

CREATE POLICY memory_chunks_insert ON memory_chunks
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM memories memory
      WHERE memory.id = memory_chunks.memory_id
        AND memory.workspace_id = memory_chunks.workspace_id
        AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)
    )
  );

CREATE POLICY memory_chunks_update ON memory_chunks
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM memories memory
      WHERE memory.id = memory_chunks.memory_id
        AND memory.workspace_id = memory_chunks.workspace_id
        AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM memories memory
      WHERE memory.id = memory_chunks.memory_id
        AND memory.workspace_id = memory_chunks.workspace_id
        AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)
    )
  );

CREATE POLICY memory_chunks_delete ON memory_chunks
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM memories memory
      WHERE memory.id = memory_chunks.memory_id
        AND memory.workspace_id = memory_chunks.workspace_id
        AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON memory_chunks TO lore_app;
