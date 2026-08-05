CREATE SCHEMA lore;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lore_app') THEN
    CREATE ROLE lore_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE membership_status AS ENUM ('active', 'suspended');
CREATE TYPE memory_scope AS ENUM ('shared', 'private');

CREATE TABLE users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role membership_role NOT NULL DEFAULT 'member',
  status membership_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE memories (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_agent_id uuid,
  scope memory_scope NOT NULL DEFAULT 'shared',
  content text NOT NULL CHECK (btrim(content) <> ''),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE INDEX memories_workspace_updated_idx ON memories (workspace_id, updated_at DESC, id);
CREATE INDEX memories_owner_updated_idx ON memories (workspace_id, owner_user_id, updated_at DESC);

CREATE FUNCTION lore.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('lore.user_id', true), '')::uuid
$$;

CREATE FUNCTION lore.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('lore.workspace_id', true), '')::uuid
$$;

CREATE FUNCTION lore.current_agent_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('lore.agent_id', true), '')::uuid
$$;

CREATE FUNCTION lore.is_active_member(target_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM memberships
    WHERE workspace_id = target_workspace_id
      AND user_id = lore.current_user_id()
      AND status = 'active'
  )
$$;

CREATE FUNCTION lore.can_read_user(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT target_user_id = lore.current_user_id()
    OR EXISTS (
      SELECT 1
      FROM memberships viewer
      JOIN memberships subject ON subject.workspace_id = viewer.workspace_id
      WHERE viewer.workspace_id = lore.current_workspace_id()
        AND viewer.user_id = lore.current_user_id()
        AND viewer.status = 'active'
        AND subject.user_id = target_user_id
        AND subject.status = 'active'
    )
$$;

CREATE FUNCTION lore.can_read_memory(
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
    AND lore.is_active_member(target_workspace_id)
    AND (target_scope = 'shared' OR target_owner_user_id = lore.current_user_id())
    AND lore.current_agent_id() IS NULL
$$;

CREATE FUNCTION lore.can_write_memory(target_workspace_id uuid, target_owner_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT target_workspace_id = lore.current_workspace_id()
    AND target_owner_user_id = lore.current_user_id()
    AND lore.is_active_member(target_workspace_id)
    AND lore.current_agent_id() IS NULL
$$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select ON users
  FOR SELECT
  USING (lore.can_read_user(id));

CREATE POLICY workspaces_select ON workspaces
  FOR SELECT
  USING (id = lore.current_workspace_id() AND lore.is_active_member(id));

CREATE POLICY memberships_select ON memberships
  FOR SELECT
  USING (
    workspace_id = lore.current_workspace_id()
    AND lore.is_active_member(workspace_id)
  );

CREATE POLICY memories_select ON memories
  FOR SELECT
  USING (lore.can_read_memory(workspace_id, owner_user_id, scope));

CREATE POLICY memories_insert ON memories
  FOR INSERT
  WITH CHECK (
    lore.can_write_memory(workspace_id, owner_user_id)
    AND created_by_agent_id IS NULL
  );

CREATE POLICY memories_update ON memories
  FOR UPDATE
  USING (lore.can_write_memory(workspace_id, owner_user_id))
  WITH CHECK (
    lore.can_write_memory(workspace_id, owner_user_id)
    AND created_by_agent_id IS NULL
  );

CREATE POLICY memories_delete ON memories
  FOR DELETE
  USING (lore.can_write_memory(workspace_id, owner_user_id));

REVOKE ALL ON SCHEMA lore FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lore FROM PUBLIC;
GRANT USAGE ON SCHEMA lore TO lore_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lore TO lore_app;
GRANT SELECT ON users, workspaces, memberships TO lore_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO lore_app;
