-- migrate:up

CREATE INDEX memories_created_by_agent_idx
  ON memories (created_by_agent_id)
  WHERE created_by_agent_id IS NOT NULL;

CREATE OR REPLACE FUNCTION lore.protect_memory_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.workspace_id <> OLD.workspace_id
    OR NEW.owner_user_id <> OLD.owner_user_id THEN
    RAISE EXCEPTION 'Memory identity and provenance are immutable';
  END IF;

  IF NEW.created_by_agent_id IS DISTINCT FROM OLD.created_by_agent_id
    THEN
    IF OLD.created_by_agent_id IS NOT NULL
      AND NEW.created_by_agent_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.agents
        WHERE id = OLD.created_by_agent_id
      ) THEN
      -- A strong Memory ETag is derived from version. The foreign-key action
      -- changes the represented provenance even though content and recency do
      -- not change, so advance version without rewriting updated_at.
      NEW.version := OLD.version + 1;
    ELSE
      RAISE EXCEPTION 'Memory identity and provenance are immutable';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION lore.protect_memory_identity() IS
  'Keeps Memory identity and provenance immutable while allowing an Agent foreign-key deletion to clear its provenance reference and advance the strong ETag version.';

REVOKE ALL ON FUNCTION lore.protect_memory_identity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.protect_memory_identity() TO lore_app;

DO $$
BEGIN
  UPDATE lore_system_state
  SET schema_revision = 7, updated_at = now()
  WHERE singleton AND schema_revision = 6;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected Lore schema revision 6 before migration 0007';
  END IF;
END
$$;

-- migrate:down
