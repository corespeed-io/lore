CREATE TYPE agent_status AS ENUM ('active', 'disabled');
CREATE TYPE agent_grant_permission AS ENUM ('read', 'write');
CREATE TYPE agent_grant_status AS ENUM ('active', 'revoked');

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  status agent_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_workspace_grants (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  permission agent_grant_permission NOT NULL DEFAULT 'read',
  status agent_grant_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, agent_id)
);

CREATE TABLE agent_credentials (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  secret_prefix text NOT NULL CHECK (length(secret_prefix) BETWEEN 8 AND 32),
  secret_hash text NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

ALTER TABLE memories
  ADD CONSTRAINT memories_created_by_agent_fk
  FOREIGN KEY (created_by_agent_id) REFERENCES agents(id) ON DELETE SET NULL;

CREATE FUNCTION lore.agent_owned_by_current_user(target_agent_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM agents
    WHERE id = target_agent_id
      AND owner_user_id = lore.current_user_id()
  )
$$;

CREATE FUNCTION lore.agent_has_access(
  target_workspace_id uuid,
  required_permission agent_grant_permission
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM agents
    JOIN agent_workspace_grants grant_row ON grant_row.agent_id = agents.id
    JOIN memberships owner_membership
      ON owner_membership.workspace_id = grant_row.workspace_id
     AND owner_membership.user_id = agents.owner_user_id
    WHERE agents.id = lore.current_agent_id()
      AND agents.owner_user_id = lore.current_user_id()
      AND agents.status = 'active'
      AND grant_row.workspace_id = target_workspace_id
      AND grant_row.status = 'active'
      AND (required_permission = 'read' OR grant_row.permission = 'write')
      AND owner_membership.status = 'active'
  )
$$;

CREATE OR REPLACE FUNCTION lore.can_read_memory(
  target_workspace_id uuid,
  target_owner_user_id uuid,
  target_scope memory_scope
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT target_workspace_id = lore.current_workspace_id()
    AND CASE
      WHEN lore.current_agent_id() IS NULL THEN lore.is_active_member(target_workspace_id)
      ELSE lore.agent_has_access(target_workspace_id, 'read')
    END
    AND (target_scope = 'shared' OR target_owner_user_id = lore.current_user_id())
$$;

CREATE OR REPLACE FUNCTION lore.can_write_memory(
  target_workspace_id uuid,
  target_owner_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT target_workspace_id = lore.current_workspace_id()
    AND target_owner_user_id = lore.current_user_id()
    AND CASE
      WHEN lore.current_agent_id() IS NULL THEN lore.is_active_member(target_workspace_id)
      ELSE lore.agent_has_access(target_workspace_id, 'write')
    END
$$;

CREATE FUNCTION lore.protect_memory_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.workspace_id <> OLD.workspace_id
    OR NEW.owner_user_id <> OLD.owner_user_id
    OR NEW.created_by_agent_id IS DISTINCT FROM OLD.created_by_agent_id THEN
    RAISE EXCEPTION 'Memory identity and provenance are immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER memories_protect_identity
BEFORE UPDATE ON memories
FOR EACH ROW EXECUTE FUNCTION lore.protect_memory_identity();

DROP POLICY memories_insert ON memories;
DROP POLICY memories_update ON memories;

CREATE POLICY memories_insert ON memories
  FOR INSERT
  WITH CHECK (
    lore.can_write_memory(workspace_id, owner_user_id)
    AND created_by_agent_id IS NOT DISTINCT FROM lore.current_agent_id()
  );

CREATE POLICY memories_update ON memories
  FOR UPDATE
  USING (lore.can_write_memory(workspace_id, owner_user_id))
  WITH CHECK (lore.can_write_memory(workspace_id, owner_user_id));

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workspace_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY agents_select ON agents
  FOR SELECT
  USING (
    owner_user_id = lore.current_user_id()
    OR EXISTS (
      SELECT 1
      FROM agent_workspace_grants
      WHERE agent_id = agents.id
        AND workspace_id = lore.current_workspace_id()
        AND status = 'active'
        AND lore.is_active_member(workspace_id)
    )
  );

CREATE POLICY agents_insert ON agents
  FOR INSERT
  WITH CHECK (
    owner_user_id = lore.current_user_id()
    AND lore.current_agent_id() IS NULL
  );

CREATE POLICY agents_update ON agents
  FOR UPDATE
  USING (owner_user_id = lore.current_user_id() AND lore.current_agent_id() IS NULL)
  WITH CHECK (owner_user_id = lore.current_user_id() AND lore.current_agent_id() IS NULL);

CREATE POLICY agents_delete ON agents
  FOR DELETE
  USING (owner_user_id = lore.current_user_id() AND lore.current_agent_id() IS NULL);

CREATE POLICY agent_grants_select ON agent_workspace_grants
  FOR SELECT
  USING (
    workspace_id = lore.current_workspace_id()
    AND (
      lore.agent_owned_by_current_user(agent_id)
      OR lore.is_active_member(workspace_id)
    )
  );

CREATE POLICY agent_grants_insert ON agent_workspace_grants
  FOR INSERT
  WITH CHECK (
    workspace_id = lore.current_workspace_id()
    AND lore.current_agent_id() IS NULL
    AND lore.is_active_member(workspace_id)
    AND lore.agent_owned_by_current_user(agent_id)
  );

CREATE POLICY agent_grants_update ON agent_workspace_grants
  FOR UPDATE
  USING (
    workspace_id = lore.current_workspace_id()
    AND lore.current_agent_id() IS NULL
    AND lore.is_active_member(workspace_id)
    AND lore.agent_owned_by_current_user(agent_id)
  )
  WITH CHECK (
    workspace_id = lore.current_workspace_id()
    AND lore.current_agent_id() IS NULL
    AND lore.is_active_member(workspace_id)
    AND lore.agent_owned_by_current_user(agent_id)
  );

CREATE POLICY agent_grants_delete ON agent_workspace_grants
  FOR DELETE
  USING (
    workspace_id = lore.current_workspace_id()
    AND lore.current_agent_id() IS NULL
    AND lore.is_active_member(workspace_id)
    AND lore.agent_owned_by_current_user(agent_id)
  );

CREATE POLICY agent_credentials_select ON agent_credentials
  FOR SELECT
  USING (lore.agent_owned_by_current_user(agent_id) AND lore.current_agent_id() IS NULL);

CREATE POLICY agent_credentials_insert ON agent_credentials
  FOR INSERT
  WITH CHECK (lore.agent_owned_by_current_user(agent_id) AND lore.current_agent_id() IS NULL);

CREATE POLICY agent_credentials_update ON agent_credentials
  FOR UPDATE
  USING (lore.agent_owned_by_current_user(agent_id) AND lore.current_agent_id() IS NULL)
  WITH CHECK (lore.agent_owned_by_current_user(agent_id) AND lore.current_agent_id() IS NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON agents, agent_workspace_grants TO lore_app;
GRANT INSERT, UPDATE, DELETE ON agent_credentials TO lore_app;
GRANT SELECT (id, agent_id, secret_prefix, created_at, last_used_at, revoked_at)
  ON agent_credentials TO lore_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lore TO lore_app;
