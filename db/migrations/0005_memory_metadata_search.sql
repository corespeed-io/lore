CREATE INDEX memories_metadata_gin_idx
  ON memories USING gin (metadata jsonb_path_ops);
