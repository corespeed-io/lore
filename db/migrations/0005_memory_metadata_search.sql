CREATE INDEX memories_metadata_gin_idx
  ON memories USING gin (metadata jsonb_path_ops);

DO $$
BEGIN
  UPDATE lore_system_state
  SET schema_revision = 5, updated_at = now()
  WHERE singleton AND schema_revision = 4;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected Lore schema revision 4 before migration 0005';
  END IF;
END
$$;
