CREATE TABLE memory_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_memory_id uuid NOT NULL,
  target_memory_id uuid NOT NULL,
  kind text NOT NULL CHECK (btrim(kind) <> '' AND length(kind) <= 64),
  weight real NOT NULL DEFAULT 1 CHECK (weight >= 0 AND weight <= 1),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_memory_id <> target_memory_id),
  UNIQUE (workspace_id, source_memory_id, target_memory_id, kind),
  FOREIGN KEY (workspace_id, source_memory_id)
    REFERENCES memories(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, target_memory_id)
    REFERENCES memories(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX memory_links_workspace_source_idx
  ON memory_links (workspace_id, source_memory_id);
CREATE INDEX memory_links_workspace_target_idx
  ON memory_links (workspace_id, target_memory_id);

CREATE FUNCTION lore.protect_memory_link_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.workspace_id <> OLD.workspace_id
    OR NEW.source_memory_id <> OLD.source_memory_id
    OR NEW.target_memory_id <> OLD.target_memory_id THEN
    RAISE EXCEPTION 'Memory Link identity and endpoints are immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER memory_links_protect_identity
BEFORE UPDATE ON memory_links
FOR EACH ROW EXECUTE FUNCTION lore.protect_memory_link_identity();

ALTER TABLE memory_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY memory_links_select ON memory_links
  FOR SELECT
  USING (
    workspace_id = lore.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM memories source
      JOIN memories target
        ON target.workspace_id = source.workspace_id
      WHERE source.workspace_id = memory_links.workspace_id
        AND source.id = memory_links.source_memory_id
        AND target.id = memory_links.target_memory_id
        AND lore.can_read_memory(source.workspace_id, source.owner_user_id, source.scope)
        AND lore.can_read_memory(target.workspace_id, target.owner_user_id, target.scope)
    )
  );

CREATE POLICY memory_links_insert ON memory_links
  FOR INSERT
  WITH CHECK (
    workspace_id = lore.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM memories source
      JOIN memories target
        ON target.workspace_id = source.workspace_id
      WHERE source.workspace_id = memory_links.workspace_id
        AND source.id = memory_links.source_memory_id
        AND target.id = memory_links.target_memory_id
        AND lore.can_write_memory(source.workspace_id, source.owner_user_id)
        AND lore.can_read_memory(target.workspace_id, target.owner_user_id, target.scope)
    )
  );

CREATE POLICY memory_links_update ON memory_links
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM memories source
      WHERE source.workspace_id = memory_links.workspace_id
        AND source.id = memory_links.source_memory_id
        AND lore.can_write_memory(source.workspace_id, source.owner_user_id)
    )
  )
  WITH CHECK (
    workspace_id = lore.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM memories source
      JOIN memories target
        ON target.workspace_id = source.workspace_id
      WHERE source.workspace_id = memory_links.workspace_id
        AND source.id = memory_links.source_memory_id
        AND target.id = memory_links.target_memory_id
        AND lore.can_write_memory(source.workspace_id, source.owner_user_id)
        AND lore.can_read_memory(target.workspace_id, target.owner_user_id, target.scope)
    )
  );

CREATE POLICY memory_links_delete ON memory_links
  FOR DELETE
  USING (
    workspace_id = lore.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM memories source
      WHERE source.workspace_id = memory_links.workspace_id
        AND source.id = memory_links.source_memory_id
        AND lore.can_write_memory(source.workspace_id, source.owner_user_id)
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON memory_links TO lore_app;
