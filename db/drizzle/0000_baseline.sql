-- Canonical Drizzle baseline: the verified Lore 0001-0009 schema.
-- Lore legacy migration 0001_initial.sql
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint


CREATE SCHEMA lore;
--> statement-breakpoint


DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lore_app') THEN
    CREATE ROLE lore_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
--> statement-breakpoint


CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'member');
--> statement-breakpoint

CREATE TYPE membership_status AS ENUM ('active', 'suspended');
--> statement-breakpoint

CREATE TYPE memory_scope AS ENUM ('shared', 'private');
--> statement-breakpoint

CREATE TYPE agent_status AS ENUM ('active', 'disabled');
--> statement-breakpoint

CREATE TYPE agent_grant_permission AS ENUM ('read', 'write');
--> statement-breakpoint

CREATE TYPE agent_grant_status AS ENUM ('active', 'revoked');
--> statement-breakpoint

CREATE TYPE evaluation_run_status AS ENUM ('running', 'completed', 'failed');
--> statement-breakpoint


CREATE TABLE users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint


CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint


CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role membership_role NOT NULL DEFAULT 'member',
  status membership_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
--> statement-breakpoint


CREATE TABLE agents (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  status agent_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint


CREATE TABLE agent_workspace_grants (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  permission agent_grant_permission NOT NULL DEFAULT 'read',
  status agent_grant_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, agent_id)
);
--> statement-breakpoint


CREATE TABLE agent_credentials (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  secret_prefix text NOT NULL CHECK (length(secret_prefix) BETWEEN 8 AND 32),
  secret_hash text NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
--> statement-breakpoint


CREATE TABLE identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (btrim(provider) <> ''),
  subject text NOT NULL CHECK (btrim(subject) <> ''),
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
--> statement-breakpoint


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
  UNIQUE (workspace_id, id),
  CONSTRAINT memories_created_by_agent_fk
    FOREIGN KEY (created_by_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);
--> statement-breakpoint


CREATE TABLE memory_chunks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  content text NOT NULL CHECK (btrim(content) <> ''),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  embedding vector(1024),
  embedding_model text,
  embedded_at timestamptz,
  embedding_provider text,
  embedding_revision text,
  UNIQUE (memory_id, ordinal),
  FOREIGN KEY (workspace_id, memory_id)
    REFERENCES memories(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT memory_chunks_embedding_state_check
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
    )
);
--> statement-breakpoint


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
--> statement-breakpoint


CREATE TABLE evaluation_suites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, created_by_user_id),
  UNIQUE (workspace_id, created_by_user_id, name, version)
);
--> statement-breakpoint


CREATE TABLE evaluation_cases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  suite_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  query text NOT NULL CHECK (btrim(query) <> ''),
  expected_memory_ids uuid[] NOT NULL CHECK (cardinality(expected_memory_ids) > 0),
  forbidden_memory_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  result_limit integer NOT NULL DEFAULT 10 CHECK (result_limit BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, suite_id, created_by_user_id)
    REFERENCES evaluation_suites(workspace_id, id, created_by_user_id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, created_by_user_id),
  UNIQUE (suite_id, ordinal)
);
--> statement-breakpoint


CREATE TABLE evaluation_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  suite_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status evaluation_run_status NOT NULL DEFAULT 'running',
  metrics jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (workspace_id, suite_id, created_by_user_id)
    REFERENCES evaluation_suites(workspace_id, id, created_by_user_id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, created_by_user_id),
  CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status <> 'running' AND completed_at IS NOT NULL)
  )
);
--> statement-breakpoint


CREATE TABLE evaluation_results (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  case_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  retrieved_memory_ids uuid[] NOT NULL,
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  latency_ms double precision NOT NULL CHECK (latency_ms >= 0),
  estimated_cost_usd numeric(16, 8) NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, run_id, created_by_user_id)
    REFERENCES evaluation_runs(workspace_id, id, created_by_user_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, case_id, created_by_user_id)
    REFERENCES evaluation_cases(workspace_id, id, created_by_user_id) ON DELETE CASCADE,
  UNIQUE (run_id, case_id)
);
--> statement-breakpoint


CREATE INDEX memories_workspace_updated_idx ON memories (workspace_id, updated_at DESC, id);
--> statement-breakpoint

CREATE INDEX memories_owner_updated_idx
  ON memories (workspace_id, owner_user_id, updated_at DESC);
--> statement-breakpoint

CREATE INDEX memory_chunks_workspace_memory_idx
  ON memory_chunks (workspace_id, memory_id);
--> statement-breakpoint

CREATE INDEX memory_chunks_search_idx ON memory_chunks USING gin (search_vector);
--> statement-breakpoint

CREATE INDEX memory_chunks_embedding_cosine_idx
  ON memory_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
--> statement-breakpoint

CREATE INDEX memory_links_workspace_source_idx
  ON memory_links (workspace_id, source_memory_id);
--> statement-breakpoint

CREATE INDEX memory_links_workspace_target_idx
  ON memory_links (workspace_id, target_memory_id);
--> statement-breakpoint

CREATE INDEX evaluation_suites_workspace_idx
  ON evaluation_suites (workspace_id, created_by_user_id, updated_at DESC, id);
--> statement-breakpoint

CREATE INDEX evaluation_cases_suite_idx
  ON evaluation_cases (workspace_id, created_by_user_id, suite_id, ordinal, id);
--> statement-breakpoint

CREATE INDEX evaluation_runs_suite_idx
  ON evaluation_runs (workspace_id, created_by_user_id, suite_id, started_at DESC, id);
--> statement-breakpoint


CREATE FUNCTION lore.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('lore.user_id', true), '')::uuid
$$;
--> statement-breakpoint


CREATE FUNCTION lore.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('lore.workspace_id', true), '')::uuid
$$;
--> statement-breakpoint


CREATE FUNCTION lore.current_agent_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('lore.agent_id', true), '')::uuid
$$;
--> statement-breakpoint


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
--> statement-breakpoint


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
--> statement-breakpoint


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
--> statement-breakpoint


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
--> statement-breakpoint


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
    AND CASE
      WHEN lore.current_agent_id() IS NULL THEN lore.is_active_member(target_workspace_id)
      ELSE lore.agent_has_access(target_workspace_id, 'read')
    END
    AND (target_scope = 'shared' OR target_owner_user_id = lore.current_user_id())
$$;
--> statement-breakpoint


CREATE FUNCTION lore.can_write_memory(target_workspace_id uuid, target_owner_user_id uuid)
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
--> statement-breakpoint


CREATE FUNCTION lore.can_manage_workspace(target_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT lore.current_agent_id() IS NULL
    AND target_workspace_id = lore.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM memberships
      WHERE workspace_id = target_workspace_id
        AND user_id = lore.current_user_id()
        AND status = 'active'
        AND role IN ('owner', 'admin')
    )
$$;
--> statement-breakpoint


CREATE FUNCTION lore.can_manage_evaluations(target_workspace_id uuid, target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT target_workspace_id = lore.current_workspace_id()
    AND target_user_id = lore.current_user_id()
    AND lore.is_active_member(target_workspace_id)
    AND lore.current_agent_id() IS NULL
$$;
--> statement-breakpoint


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
--> statement-breakpoint


CREATE TRIGGER memories_protect_identity
BEFORE UPDATE ON memories
FOR EACH ROW EXECUTE FUNCTION lore.protect_memory_identity();
--> statement-breakpoint


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
--> statement-breakpoint


CREATE TRIGGER memory_links_protect_identity
BEFORE UPDATE ON memory_links
FOR EACH ROW EXECUTE FUNCTION lore.protect_memory_link_identity();
--> statement-breakpoint


CREATE FUNCTION lore.authenticate_agent_credential(
  candidate_secret_hash text,
  target_workspace_id uuid
)
RETURNS TABLE (user_id uuid, agent_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  UPDATE agent_credentials credential
  SET last_used_at = now()
  FROM agents agent,
       agent_workspace_grants grant_row,
       memberships owner_membership
  WHERE credential.secret_hash = candidate_secret_hash
    AND credential.revoked_at IS NULL
    AND agent.id = credential.agent_id
    AND agent.status = 'active'
    AND grant_row.agent_id = agent.id
    AND grant_row.workspace_id = target_workspace_id
    AND grant_row.status = 'active'
    AND owner_membership.workspace_id = target_workspace_id
    AND owner_membership.user_id = agent.owner_user_id
    AND owner_membership.status = 'active'
  RETURNING agent.owner_user_id, agent.id;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.register_identity(
  new_user_id uuid,
  new_identity_id uuid,
  identity_provider text,
  identity_subject text,
  user_display_name text,
  identity_email text
)
RETURNS TABLE (
  id uuid,
  display_name text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  SELECT app_user.id, app_user.display_name, app_user.created_at, app_user.updated_at
  FROM identities identity_row
  JOIN users app_user ON app_user.id = identity_row.user_id
  WHERE identity_row.provider = identity_provider
    AND identity_row.subject = identity_subject;
  IF FOUND THEN
    RETURN;
  END IF;

  BEGIN
    INSERT INTO users (id, display_name)
    VALUES (new_user_id, user_display_name);

    INSERT INTO identities (id, user_id, provider, subject, email)
    VALUES (
      new_identity_id,
      new_user_id,
      identity_provider,
      identity_subject,
      nullif(identity_email, '')
    );
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent registration won. The subtransaction rolls back both inserts;
    -- return the already-established internal User below.
  END;

  RETURN QUERY
  SELECT app_user.id, app_user.display_name, app_user.created_at, app_user.updated_at
  FROM identities identity_row
  JOIN users app_user ON app_user.id = identity_row.user_id
  WHERE identity_row.provider = identity_provider
    AND identity_row.subject = identity_subject;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.resolve_identity(identity_provider text, identity_subject text)
RETURNS TABLE (
  id uuid,
  display_name text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT app_user.id, app_user.display_name, app_user.created_at, app_user.updated_at
  FROM identities identity_row
  JOIN users app_user ON app_user.id = identity_row.user_id
  WHERE identity_row.provider = identity_provider
    AND identity_row.subject = identity_subject
$$;
--> statement-breakpoint


CREATE FUNCTION lore.create_workspace(new_workspace_id uuid, workspace_name text)
RETURNS TABLE (
  id uuid,
  name text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO workspaces (id, name)
  VALUES (new_workspace_id, workspace_name);

  INSERT INTO memberships (workspace_id, user_id, role)
  VALUES (new_workspace_id, lore.current_user_id(), 'owner');

  RETURN QUERY
  SELECT workspace.id, workspace.name, workspace.created_at, workspace.updated_at
  FROM workspaces workspace
  WHERE workspace.id = new_workspace_id;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.list_workspaces()
RETURNS TABLE (
  id uuid,
  name text,
  role membership_role,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    workspace.id,
    workspace.name,
    membership.role,
    workspace.created_at,
    workspace.updated_at
  FROM memberships membership
  JOIN workspaces workspace ON workspace.id = membership.workspace_id
  WHERE membership.user_id = lore.current_user_id()
    AND membership.status = 'active'
  ORDER BY workspace.name, workspace.id
$$;
--> statement-breakpoint


ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE agent_workspace_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE agent_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE identities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE memory_chunks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE memory_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE evaluation_suites ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE evaluation_cases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE evaluation_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE evaluation_results ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint


CREATE POLICY users_select ON users
  FOR SELECT
  USING (lore.can_read_user(id));
--> statement-breakpoint


CREATE POLICY workspaces_select ON workspaces
  FOR SELECT
  USING (id = lore.current_workspace_id() AND lore.is_active_member(id));
--> statement-breakpoint


CREATE POLICY memberships_select ON memberships
  FOR SELECT
  USING (
    workspace_id = lore.current_workspace_id()
    AND lore.is_active_member(workspace_id)
  );
--> statement-breakpoint


CREATE POLICY memberships_insert ON memberships
  FOR INSERT
  WITH CHECK (lore.can_manage_workspace(workspace_id));
--> statement-breakpoint


CREATE POLICY memberships_update ON memberships
  FOR UPDATE
  USING (lore.can_manage_workspace(workspace_id))
  WITH CHECK (lore.can_manage_workspace(workspace_id));
--> statement-breakpoint


CREATE POLICY memberships_delete ON memberships
  FOR DELETE
  USING (lore.can_manage_workspace(workspace_id));
--> statement-breakpoint


CREATE POLICY agents_select ON agents
  FOR SELECT
  USING (
    owner_user_id = lore.current_user_id()
    AND lore.current_agent_id() IS NULL
  );
--> statement-breakpoint


CREATE POLICY agents_insert ON agents
  FOR INSERT
  WITH CHECK (
    owner_user_id = lore.current_user_id()
    AND lore.current_agent_id() IS NULL
  );
--> statement-breakpoint


CREATE POLICY agents_update ON agents
  FOR UPDATE
  USING (owner_user_id = lore.current_user_id() AND lore.current_agent_id() IS NULL)
  WITH CHECK (owner_user_id = lore.current_user_id() AND lore.current_agent_id() IS NULL);
--> statement-breakpoint


CREATE POLICY agents_delete ON agents
  FOR DELETE
  USING (owner_user_id = lore.current_user_id() AND lore.current_agent_id() IS NULL);
--> statement-breakpoint


CREATE POLICY agent_grants_select ON agent_workspace_grants
  FOR SELECT
  USING (
    workspace_id = lore.current_workspace_id()
    AND lore.current_agent_id() IS NULL
    AND lore.agent_owned_by_current_user(agent_id)
  );
--> statement-breakpoint


CREATE POLICY agent_grants_insert ON agent_workspace_grants
  FOR INSERT
  WITH CHECK (
    workspace_id = lore.current_workspace_id()
    AND lore.current_agent_id() IS NULL
    AND lore.is_active_member(workspace_id)
    AND lore.agent_owned_by_current_user(agent_id)
  );
--> statement-breakpoint


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
--> statement-breakpoint


CREATE POLICY agent_grants_delete ON agent_workspace_grants
  FOR DELETE
  USING (
    workspace_id = lore.current_workspace_id()
    AND lore.current_agent_id() IS NULL
    AND lore.is_active_member(workspace_id)
    AND lore.agent_owned_by_current_user(agent_id)
  );
--> statement-breakpoint


CREATE POLICY agent_credentials_select ON agent_credentials
  FOR SELECT
  USING (lore.agent_owned_by_current_user(agent_id) AND lore.current_agent_id() IS NULL);
--> statement-breakpoint


CREATE POLICY agent_credentials_insert ON agent_credentials
  FOR INSERT
  WITH CHECK (lore.agent_owned_by_current_user(agent_id) AND lore.current_agent_id() IS NULL);
--> statement-breakpoint


CREATE POLICY agent_credentials_update ON agent_credentials
  FOR UPDATE
  USING (lore.agent_owned_by_current_user(agent_id) AND lore.current_agent_id() IS NULL)
  WITH CHECK (lore.agent_owned_by_current_user(agent_id) AND lore.current_agent_id() IS NULL);
--> statement-breakpoint


CREATE POLICY identities_select ON identities
  FOR SELECT
  USING (user_id = lore.current_user_id());
--> statement-breakpoint


CREATE POLICY memories_select ON memories
  FOR SELECT
  USING (lore.can_read_memory(workspace_id, owner_user_id, scope));
--> statement-breakpoint


CREATE POLICY memories_insert ON memories
  FOR INSERT
  WITH CHECK (
    lore.can_write_memory(workspace_id, owner_user_id)
    AND created_by_agent_id IS NOT DISTINCT FROM lore.current_agent_id()
  );
--> statement-breakpoint


CREATE POLICY memories_update ON memories
  FOR UPDATE
  USING (lore.can_write_memory(workspace_id, owner_user_id))
  WITH CHECK (lore.can_write_memory(workspace_id, owner_user_id));
--> statement-breakpoint


CREATE POLICY memories_delete ON memories
  FOR DELETE
  USING (lore.can_write_memory(workspace_id, owner_user_id));
--> statement-breakpoint


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
--> statement-breakpoint


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
--> statement-breakpoint


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
--> statement-breakpoint


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
--> statement-breakpoint


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
--> statement-breakpoint


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
--> statement-breakpoint


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
--> statement-breakpoint


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
--> statement-breakpoint


CREATE POLICY evaluation_suites_all ON evaluation_suites
  FOR ALL
  USING (lore.can_manage_evaluations(workspace_id, created_by_user_id))
  WITH CHECK (lore.can_manage_evaluations(workspace_id, created_by_user_id));
--> statement-breakpoint


CREATE POLICY evaluation_cases_all ON evaluation_cases
  FOR ALL
  USING (lore.can_manage_evaluations(workspace_id, created_by_user_id))
  WITH CHECK (lore.can_manage_evaluations(workspace_id, created_by_user_id));
--> statement-breakpoint


CREATE POLICY evaluation_runs_all ON evaluation_runs
  FOR ALL
  USING (lore.can_manage_evaluations(workspace_id, created_by_user_id))
  WITH CHECK (lore.can_manage_evaluations(workspace_id, created_by_user_id));
--> statement-breakpoint


CREATE POLICY evaluation_results_all ON evaluation_results
  FOR ALL
  USING (lore.can_manage_evaluations(workspace_id, created_by_user_id))
  WITH CHECK (lore.can_manage_evaluations(workspace_id, created_by_user_id));
--> statement-breakpoint


REVOKE ALL ON SCHEMA lore FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lore FROM PUBLIC;
--> statement-breakpoint


GRANT USAGE ON SCHEMA lore TO lore_app;
--> statement-breakpoint

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lore TO lore_app;
--> statement-breakpoint

GRANT SELECT ON users, workspaces, memberships TO lore_app;
--> statement-breakpoint

GRANT INSERT, UPDATE, DELETE ON memberships TO lore_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON memories, agents, agent_workspace_grants, memory_chunks, memory_links,
     evaluation_suites, evaluation_cases, evaluation_runs, evaluation_results
  TO lore_app;
--> statement-breakpoint

GRANT INSERT, UPDATE, DELETE ON agent_credentials TO lore_app;
--> statement-breakpoint

GRANT SELECT (id, agent_id, secret_prefix, created_at, last_used_at, revoked_at)
  ON agent_credentials TO lore_app;
--> statement-breakpoint

GRANT SELECT (id, user_id, provider, subject, email, created_at, updated_at)
  ON identities TO lore_app;
--> statement-breakpoint



-- Lore legacy migration 0002_memory_embedding_jobs.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lore_maintenance') THEN
    CREATE ROLE lore_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
--> statement-breakpoint


CREATE TYPE memory_embedding_job_status AS ENUM (
  'pending',
  'processing',
  'succeeded',
  'dead',
  'cancelled'
);
--> statement-breakpoint


CREATE TABLE memory_embedding_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  memory_scope memory_scope NOT NULL,
  memory_version integer NOT NULL CHECK (memory_version > 0),
  embedding_provider text NOT NULL CHECK (btrim(embedding_provider) <> ''),
  embedding_model text NOT NULL CHECK (btrim(embedding_model) <> ''),
  embedding_revision text NOT NULL CHECK (btrim(embedding_revision) <> ''),
  status memory_embedding_job_status NOT NULL DEFAULT 'pending',
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts smallint NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 32),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  leased_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 1000),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, memory_id)
    REFERENCES memories(workspace_id, id)
    ON DELETE CASCADE,
  UNIQUE (
    workspace_id,
    memory_id,
    memory_version,
    embedding_provider,
    embedding_model,
    embedding_revision
  ),
  CHECK (
    (status = 'pending' AND lease_token IS NULL AND leased_at IS NULL AND completed_at IS NULL)
    OR (
      status = 'processing'
      AND lease_token IS NOT NULL
      AND leased_at IS NOT NULL
      AND completed_at IS NULL
    )
    OR (
      status IN ('succeeded', 'dead', 'cancelled')
      AND lease_token IS NULL
      AND leased_at IS NULL
      AND completed_at IS NOT NULL
    )
  )
);
--> statement-breakpoint


CREATE INDEX memory_embedding_jobs_pending_idx
  ON memory_embedding_jobs (
    embedding_provider,
    embedding_model,
    embedding_revision,
    available_at,
    created_at,
    id
  )
  WHERE status IN ('pending', 'processing');
--> statement-breakpoint


CREATE INDEX memory_embedding_jobs_terminal_completed_idx
  ON memory_embedding_jobs (completed_at)
  WHERE status IN ('succeeded', 'dead', 'cancelled');
--> statement-breakpoint


CREATE FUNCTION lore.current_maintenance_job_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('lore.maintenance_job_id', true), '')::uuid
$$;
--> statement-breakpoint


CREATE FUNCTION lore.current_maintenance_lease_token()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('lore.maintenance_lease_token', true), '')::uuid
$$;
--> statement-breakpoint


CREATE FUNCTION lore.can_maintain_memory(target_workspace_id uuid, target_memory_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM memory_embedding_jobs job
    JOIN memories memory
      ON memory.workspace_id = job.workspace_id
     AND memory.id = job.memory_id
     AND memory.owner_user_id = job.owner_user_id
     AND memory.scope = job.memory_scope
     AND memory.version = job.memory_version
    WHERE job.id = lore.current_maintenance_job_id()
      AND job.lease_token = lore.current_maintenance_lease_token()
      AND job.status = 'processing'
      AND job.workspace_id = target_workspace_id
      AND job.memory_id = target_memory_id
  )
$$;
--> statement-breakpoint


CREATE FUNCTION lore.claim_memory_embedding_job(
  requested_job_id uuid,
  active_embedding_provider text,
  active_embedding_model text,
  active_embedding_revision text,
  new_lease_token uuid,
  lease_timeout_seconds integer
)
RETURNS TABLE (
  id uuid,
  workspace_id uuid,
  memory_id uuid,
  owner_user_id uuid,
  memory_scope memory_scope,
  memory_version integer,
  attempt_count smallint,
  chunks jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF btrim(active_embedding_provider) = ''
    OR btrim(active_embedding_model) = ''
    OR btrim(active_embedding_revision) = '' THEN
    RAISE EXCEPTION 'Active embedding identity is required';
  END IF;
  IF lease_timeout_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'Lease timeout must be between 30 and 3600 seconds';
  END IF;

  UPDATE memory_embedding_jobs job
  SET status = 'cancelled',
      lease_token = NULL,
      leased_at = NULL,
      completed_at = now(),
      updated_at = now()
  FROM memories memory
  WHERE memory.workspace_id = job.workspace_id
    AND memory.id = job.memory_id
    AND (
      memory.version <> job.memory_version
      OR memory.owner_user_id <> job.owner_user_id
      OR memory.scope <> job.memory_scope
    )
    AND job.status IN ('pending', 'processing');

  UPDATE memory_embedding_jobs job
  SET status = 'dead',
      lease_token = NULL,
      leased_at = NULL,
      last_error = COALESCE(job.last_error, 'Embedding job lease expired'),
      completed_at = now(),
      updated_at = now()
  WHERE job.status = 'processing'
    AND job.leased_at <= now() - lease_timeout_seconds * interval '1 second'
    AND job.attempt_count >= job.max_attempts;

  RETURN QUERY
  WITH candidate AS (
    SELECT job.id
    FROM memory_embedding_jobs job
    JOIN memories memory
      ON memory.workspace_id = job.workspace_id
     AND memory.id = job.memory_id
     AND memory.owner_user_id = job.owner_user_id
     AND memory.scope = job.memory_scope
     AND memory.version = job.memory_version
    WHERE (requested_job_id IS NULL OR job.id = requested_job_id)
      AND job.embedding_provider = active_embedding_provider
      AND job.embedding_model = active_embedding_model
      AND job.embedding_revision = active_embedding_revision
      AND job.attempt_count < job.max_attempts
      AND (
        (job.status = 'pending' AND job.available_at <= now())
        OR (
          job.status = 'processing'
          AND job.leased_at <= now() - lease_timeout_seconds * interval '1 second'
        )
      )
    ORDER BY job.available_at, job.created_at, job.id
    FOR UPDATE OF job SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE memory_embedding_jobs job
    SET status = 'processing',
        attempt_count = job.attempt_count + 1,
        lease_token = new_lease_token,
        leased_at = now(),
        completed_at = NULL,
        updated_at = now()
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.*
  )
  SELECT
    claimed.id,
    claimed.workspace_id,
    claimed.memory_id,
    claimed.owner_user_id,
    claimed.memory_scope,
    claimed.memory_version,
    claimed.attempt_count,
    COALESCE(
      jsonb_agg(
        jsonb_build_object('id', chunk.id, 'content', chunk.content)
        ORDER BY chunk.ordinal, chunk.id
      ) FILTER (WHERE chunk.id IS NOT NULL),
      '[]'::jsonb
    ) AS chunks
  FROM claimed
  LEFT JOIN memory_chunks chunk
    ON chunk.workspace_id = claimed.workspace_id
   AND chunk.memory_id = claimed.memory_id
  GROUP BY
    claimed.id,
    claimed.workspace_id,
    claimed.memory_id,
    claimed.owner_user_id,
    claimed.memory_scope,
    claimed.memory_version,
    claimed.attempt_count;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.finish_memory_embedding_job(
  target_job_id uuid,
  target_lease_token uuid,
  failure_detail text,
  retry_delay_seconds integer
)
RETURNS memory_embedding_job_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  final_status memory_embedding_job_status;
BEGIN
  IF retry_delay_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'Retry delay must be between 1 and 86400 seconds';
  END IF;

  UPDATE memory_embedding_jobs job
  SET status = CASE
        WHEN failure_detail IS NULL THEN 'succeeded'::memory_embedding_job_status
        WHEN job.attempt_count >= job.max_attempts THEN 'dead'::memory_embedding_job_status
        ELSE 'pending'::memory_embedding_job_status
      END,
      available_at = CASE
        WHEN failure_detail IS NOT NULL AND job.attempt_count < job.max_attempts
          THEN now() + retry_delay_seconds * interval '1 second'
        ELSE job.available_at
      END,
      lease_token = NULL,
      leased_at = NULL,
      last_error = CASE
        WHEN failure_detail IS NULL THEN NULL
        ELSE left(failure_detail, 1000)
      END,
      completed_at = CASE
        WHEN failure_detail IS NULL OR job.attempt_count >= job.max_attempts THEN now()
        ELSE NULL
      END,
      updated_at = now()
  WHERE job.id = target_job_id
    AND job.lease_token = target_lease_token
    AND job.status = 'processing'
  RETURNING job.status INTO final_status;

  RETURN final_status;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.enqueue_stale_memory_embedding_jobs(
  active_embedding_provider text,
  active_embedding_model text,
  active_embedding_revision text,
  job_limit integer
)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF btrim(active_embedding_provider) = ''
    OR btrim(active_embedding_model) = ''
    OR btrim(active_embedding_revision) = '' THEN
    RAISE EXCEPTION 'Active embedding identity is required';
  END IF;
  IF job_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Job limit must be between 1 and 10000';
  END IF;

  DELETE FROM memory_embedding_jobs job
  WHERE (
      job.status IN ('succeeded', 'cancelled')
      AND job.completed_at < now() - interval '7 days'
    )
    OR (
      job.status = 'dead'
      AND job.completed_at < now() - interval '30 days'
    );

  UPDATE memory_embedding_jobs job
  SET status = 'cancelled',
      lease_token = NULL,
      leased_at = NULL,
      completed_at = now(),
      updated_at = now()
  FROM memories memory
  WHERE memory.workspace_id = job.workspace_id
    AND memory.id = job.memory_id
    AND job.status IN ('pending', 'processing')
    AND (
      memory.version <> job.memory_version
      OR memory.owner_user_id <> job.owner_user_id
      OR memory.scope <> job.memory_scope
      OR job.embedding_provider <> active_embedding_provider
      OR job.embedding_model <> active_embedding_model
      OR job.embedding_revision <> active_embedding_revision
    );

  RETURN QUERY
  WITH candidates AS (
    SELECT memory.workspace_id, memory.id AS memory_id, memory.version
    FROM memories memory
    WHERE EXISTS (
      SELECT 1
      FROM memory_chunks chunk
      WHERE chunk.workspace_id = memory.workspace_id
        AND chunk.memory_id = memory.id
        AND (
          chunk.embedding IS NULL
          OR chunk.embedding_provider <> active_embedding_provider
          OR chunk.embedding_model <> active_embedding_model
          OR chunk.embedding_revision <> active_embedding_revision
        )
    )
      AND NOT EXISTS (
        SELECT 1
        FROM memory_embedding_jobs existing_job
        WHERE existing_job.workspace_id = memory.workspace_id
          AND existing_job.memory_id = memory.id
          AND existing_job.memory_version = memory.version
          AND existing_job.embedding_provider = active_embedding_provider
          AND existing_job.embedding_model = active_embedding_model
          AND existing_job.embedding_revision = active_embedding_revision
          AND existing_job.status IN ('pending', 'processing', 'dead')
      )
    ORDER BY memory.updated_at, memory.id
    LIMIT job_limit
  )
  INSERT INTO memory_embedding_jobs (
    id,
    workspace_id,
    memory_id,
    owner_user_id,
    memory_scope,
    memory_version,
    embedding_provider,
    embedding_model,
    embedding_revision
  )
  SELECT
    gen_random_uuid(),
    candidate.workspace_id,
    candidate.memory_id,
    memory.owner_user_id,
    memory.scope,
    candidate.version,
    active_embedding_provider,
    active_embedding_model,
    active_embedding_revision
  FROM candidates candidate
  JOIN memories memory
    ON memory.workspace_id = candidate.workspace_id
   AND memory.id = candidate.memory_id
  ON CONFLICT (
    workspace_id,
    memory_id,
    memory_version,
    embedding_provider,
    embedding_model,
    embedding_revision
  ) DO UPDATE
  SET status = 'pending',
      attempt_count = 0,
      available_at = now(),
      lease_token = NULL,
      leased_at = NULL,
      last_error = NULL,
      completed_at = NULL,
      updated_at = now()
  WHERE memory_embedding_jobs.status IN ('succeeded', 'cancelled')
  RETURNING memory_embedding_jobs.id;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.list_pending_memory_embedding_jobs(
  active_embedding_provider text,
  active_embedding_model text,
  active_embedding_revision text,
  lease_timeout_seconds integer,
  job_limit integer
)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT job.id
  FROM memory_embedding_jobs job
  JOIN memories memory
    ON memory.workspace_id = job.workspace_id
   AND memory.id = job.memory_id
   AND memory.owner_user_id = job.owner_user_id
   AND memory.scope = job.memory_scope
   AND memory.version = job.memory_version
  WHERE job.embedding_provider = active_embedding_provider
    AND job.embedding_model = active_embedding_model
    AND job.embedding_revision = active_embedding_revision
    AND job.attempt_count < job.max_attempts
    AND (
      (job.status = 'pending' AND job.available_at <= now())
      OR (
        job.status = 'processing'
        AND job.leased_at <= now() - lease_timeout_seconds * interval '1 second'
      )
    )
  ORDER BY job.available_at, job.created_at, job.id
  LIMIT job_limit
$$;
--> statement-breakpoint


ALTER TABLE memory_embedding_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint


-- The initial policies predate the maintenance role and default to PUBLIC.
-- Scope them to the request role so granting the worker UPDATE cannot make the
-- actor-context policy execute for a maintenance transaction.
ALTER POLICY memory_chunks_select ON memory_chunks TO lore_app;
--> statement-breakpoint

ALTER POLICY memory_chunks_insert ON memory_chunks TO lore_app;
--> statement-breakpoint

ALTER POLICY memory_chunks_update ON memory_chunks TO lore_app;
--> statement-breakpoint

ALTER POLICY memory_chunks_delete ON memory_chunks TO lore_app;
--> statement-breakpoint


CREATE POLICY memory_embedding_jobs_insert ON memory_embedding_jobs
  FOR INSERT
  TO lore_app
  WITH CHECK (
    workspace_id = lore.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM memories memory
      WHERE memory.workspace_id = memory_embedding_jobs.workspace_id
        AND memory.id = memory_embedding_jobs.memory_id
        AND memory.owner_user_id = memory_embedding_jobs.owner_user_id
        AND memory.scope = memory_embedding_jobs.memory_scope
        AND memory.version = memory_embedding_jobs.memory_version
        AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)
    )
  );
--> statement-breakpoint


CREATE POLICY memory_chunks_maintenance_select ON memory_chunks
  FOR SELECT
  TO lore_maintenance
  USING (lore.can_maintain_memory(workspace_id, memory_id));
--> statement-breakpoint


CREATE POLICY memory_chunks_maintenance_update ON memory_chunks
  FOR UPDATE
  TO lore_maintenance
  USING (lore.can_maintain_memory(workspace_id, memory_id))
  WITH CHECK (lore.can_maintain_memory(workspace_id, memory_id));
--> statement-breakpoint


REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lore FROM PUBLIC;
--> statement-breakpoint


GRANT USAGE ON SCHEMA lore TO lore_maintenance;
--> statement-breakpoint

GRANT SELECT, UPDATE ON memory_chunks TO lore_maintenance;
--> statement-breakpoint

GRANT INSERT ON memory_embedding_jobs TO lore_app;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.current_maintenance_job_id() TO lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.current_maintenance_lease_token() TO lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.can_maintain_memory(uuid, uuid) TO lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.claim_memory_embedding_job(uuid, text, text, text, uuid, integer)
  TO lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.finish_memory_embedding_job(uuid, uuid, text, integer)
  TO lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.enqueue_stale_memory_embedding_jobs(text, text, text, integer)
  TO lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.list_pending_memory_embedding_jobs(text, text, text, integer, integer)
  TO lore_maintenance;
--> statement-breakpoint



-- Lore legacy migration 0003_portable_core.sql
CREATE TYPE embedding_generation_status AS ENUM (
  'building',
  'active',
  'retiring',
  'failed'
);
--> statement-breakpoint


CREATE TABLE lore_system_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  deployment_id uuid NOT NULL DEFAULT gen_random_uuid(),
  schema_revision integer NOT NULL CHECK (schema_revision > 0),
  api_version text NOT NULL CHECK (btrim(api_version) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint


INSERT INTO lore_system_state (schema_revision, api_version)
VALUES (3, 'v1');
--> statement-breakpoint


CREATE TABLE request_idempotency_records (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'agent')),
  actor_id uuid NOT NULL,
  operation text NOT NULL CHECK (btrim(operation) <> '' AND length(operation) <= 128),
  idempotency_key text NOT NULL CHECK (
    btrim(idempotency_key) <> '' AND length(idempotency_key) <= 128
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response_status smallint CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  UNIQUE (workspace_id, actor_kind, actor_id, operation, idempotency_key),
  CHECK (
    (status = 'in_progress' AND response_status IS NULL AND response_body IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND response_status IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);
--> statement-breakpoint


CREATE INDEX request_idempotency_records_expiry_idx
  ON request_idempotency_records (expires_at);
--> statement-breakpoint


CREATE TABLE memory_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  workspace_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  memory_scope memory_scope NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('memory', 'memory_link')),
  resource_id uuid NOT NULL,
  source_memory_id uuid,
  related_memory_id uuid,
  event_type text NOT NULL CHECK (event_type IN (
    'memory.created',
    'memory.updated',
    'memory.deleted',
    'memory_link.created',
    'memory_link.updated',
    'memory_link.deleted'
  )),
  actor_user_id uuid,
  actor_agent_id uuid,
  request_id uuid,
  before_version integer,
  after_version integer,
  changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  before_content_sha256 text CHECK (
    before_content_sha256 IS NULL OR before_content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  after_content_sha256 text CHECK (
    after_content_sha256 IS NULL OR after_content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '90 days',
  CHECK (
    (resource_type = 'memory' AND source_memory_id IS NULL AND related_memory_id IS NULL)
    OR
    (resource_type = 'memory_link' AND source_memory_id IS NOT NULL AND related_memory_id IS NOT NULL)
  )
);
--> statement-breakpoint


CREATE INDEX memory_events_workspace_sequence_idx
  ON memory_events (workspace_id, sequence);
--> statement-breakpoint

CREATE INDEX memory_events_expiry_idx ON memory_events (expires_at);
--> statement-breakpoint


CREATE TABLE embedding_generations (
  id uuid PRIMARY KEY,
  embedding_provider text NOT NULL CHECK (btrim(embedding_provider) <> ''),
  embedding_model text NOT NULL CHECK (btrim(embedding_model) <> ''),
  embedding_dimensions integer NOT NULL CHECK (embedding_dimensions = 1024),
  embedding_revision text NOT NULL CHECK (btrim(embedding_revision) <> ''),
  status embedding_generation_status NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz,
  validated_at timestamptz,
  failure_detail text CHECK (failure_detail IS NULL OR length(failure_detail) <= 1000),
  UNIQUE (
    embedding_provider,
    embedding_model,
    embedding_dimensions,
    embedding_revision
  ),
  CHECK (
    (status = 'active' AND activated_at IS NOT NULL AND retired_at IS NULL)
    OR (status = 'retiring' AND activated_at IS NOT NULL AND retired_at IS NOT NULL)
    OR (status IN ('building', 'failed') AND activated_at IS NULL)
  )
);
--> statement-breakpoint


CREATE UNIQUE INDEX embedding_generations_one_active_idx
  ON embedding_generations ((status))
  WHERE status = 'active';
--> statement-breakpoint


CREATE TABLE memory_chunk_embeddings (
  generation_id uuid NOT NULL REFERENCES embedding_generations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  chunk_id uuid NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  embedding vector(1024) NOT NULL CHECK (vector_dims(embedding) = 1024),
  embedded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (generation_id, chunk_id),
  FOREIGN KEY (workspace_id, memory_id)
    REFERENCES memories(workspace_id, id)
    ON DELETE CASCADE
);
--> statement-breakpoint


CREATE INDEX memory_chunk_embeddings_workspace_memory_idx
  ON memory_chunk_embeddings (workspace_id, memory_id, generation_id);
--> statement-breakpoint

CREATE INDEX memory_chunk_embeddings_cosine_idx
  ON memory_chunk_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
--> statement-breakpoint


-- Preserve the currently deployed vector space as the active generation. Older
-- spaces remain available for bounded rolling-deploy compatibility and rollback.
WITH spaces AS (
  SELECT
    chunk.embedding_provider,
    chunk.embedding_model,
    chunk.embedding_revision,
    max(chunk.embedded_at) AS latest_embedded_at,
    count(*) AS vector_count
  FROM memory_chunks chunk
  WHERE chunk.embedding IS NOT NULL
  GROUP BY chunk.embedding_provider, chunk.embedding_model, chunk.embedding_revision
), ranked AS (
  SELECT
    spaces.*,
    row_number() OVER (
      ORDER BY spaces.latest_embedded_at DESC NULLS LAST,
               spaces.vector_count DESC,
               spaces.embedding_provider,
               spaces.embedding_model,
               spaces.embedding_revision
    ) AS generation_rank
  FROM spaces
)
INSERT INTO embedding_generations (
  id,
  embedding_provider,
  embedding_model,
  embedding_dimensions,
  embedding_revision,
  status,
  activated_at,
  retired_at,
  validated_at
)
SELECT
  gen_random_uuid(),
  ranked.embedding_provider,
  ranked.embedding_model,
  1024,
  ranked.embedding_revision,
  CASE WHEN ranked.generation_rank = 1
    THEN 'active'::embedding_generation_status
    ELSE 'retiring'::embedding_generation_status
  END,
  COALESCE(ranked.latest_embedded_at, now()),
  CASE WHEN ranked.generation_rank = 1 THEN NULL ELSE now() END,
  now()
FROM ranked;
--> statement-breakpoint


INSERT INTO memory_chunk_embeddings (
  generation_id,
  workspace_id,
  memory_id,
  chunk_id,
  embedding,
  embedded_at
)
SELECT
  generation.id,
  chunk.workspace_id,
  chunk.memory_id,
  chunk.id,
  chunk.embedding,
  chunk.embedded_at
FROM memory_chunks chunk
JOIN embedding_generations generation
  ON generation.embedding_provider = chunk.embedding_provider
 AND generation.embedding_model = chunk.embedding_model
 AND generation.embedding_revision = chunk.embedding_revision
WHERE chunk.embedding IS NOT NULL;
--> statement-breakpoint


-- Existing jobs become members of their exact vector generation. A job-only
-- identity is building unless the deployment has no vectors or active generation.
WITH job_spaces AS (
  SELECT DISTINCT
    job.embedding_provider,
    job.embedding_model,
    job.embedding_revision
  FROM memory_embedding_jobs job
), ranked_job_spaces AS (
  SELECT
    job_spaces.*,
    row_number() OVER (
      ORDER BY job_spaces.embedding_provider,
               job_spaces.embedding_model,
               job_spaces.embedding_revision
    ) AS generation_rank
  FROM job_spaces
)
INSERT INTO embedding_generations (
  id,
  embedding_provider,
  embedding_model,
  embedding_dimensions,
  embedding_revision,
  status,
  activated_at
)
SELECT
  gen_random_uuid(),
  ranked_job_spaces.embedding_provider,
  ranked_job_spaces.embedding_model,
  1024,
  ranked_job_spaces.embedding_revision,
  CASE WHEN ranked_job_spaces.generation_rank = 1
    AND NOT EXISTS (
      SELECT 1
      FROM embedding_generations active_generation
      WHERE active_generation.status = 'active'
    )
    THEN 'active'::embedding_generation_status
    ELSE 'building'::embedding_generation_status
  END,
  CASE WHEN ranked_job_spaces.generation_rank = 1
    AND NOT EXISTS (
      SELECT 1
      FROM embedding_generations active_generation
      WHERE active_generation.status = 'active'
    )
    THEN now()
    ELSE NULL
  END
FROM ranked_job_spaces
ON CONFLICT (
  embedding_provider,
  embedding_model,
  embedding_dimensions,
  embedding_revision
) DO NOTHING;
--> statement-breakpoint


ALTER TABLE memory_embedding_jobs
  ADD COLUMN generation_id uuid REFERENCES embedding_generations(id);
--> statement-breakpoint


UPDATE memory_embedding_jobs job
SET generation_id = generation.id
FROM embedding_generations generation
WHERE generation.embedding_provider = job.embedding_provider
  AND generation.embedding_model = job.embedding_model
  AND generation.embedding_revision = job.embedding_revision;
--> statement-breakpoint


CREATE INDEX memory_embedding_jobs_generation_status_idx
  ON memory_embedding_jobs (generation_id, status, available_at, created_at, id);
--> statement-breakpoint


CREATE TABLE workspace_imports (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  imported_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[0-9a-f]{64}$'),
  source_deployment_id uuid NOT NULL,
  source_workspace_id uuid NOT NULL,
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, imported_by_user_id, archive_sha256)
);
--> statement-breakpoint


CREATE TABLE memory_import_provenance (
  workspace_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  import_id uuid NOT NULL REFERENCES workspace_imports(id) ON DELETE CASCADE,
  source_memory_id uuid NOT NULL,
  source_owner_user_id uuid NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, memory_id),
  FOREIGN KEY (workspace_id, memory_id)
    REFERENCES memories(workspace_id, id)
    ON DELETE CASCADE
);
--> statement-breakpoint


CREATE FUNCTION lore.current_request_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('lore.request_id', true), '')::uuid
$$;
--> statement-breakpoint


CREATE FUNCTION lore.append_memory_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  changed text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    changed := ARRAY['content', 'metadata', 'scope'];
    INSERT INTO memory_events (
      id, workspace_id, owner_user_id, memory_scope,
      resource_type, resource_id, event_type,
      actor_user_id, actor_agent_id, request_id,
      after_version, changed_fields, after_content_sha256
    ) VALUES (
      gen_random_uuid(), NEW.workspace_id, NEW.owner_user_id, NEW.scope,
      'memory', NEW.id, 'memory.created',
      lore.current_user_id(), lore.current_agent_id(), lore.current_request_id(),
      NEW.version, changed,
      encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex')
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.content IS DISTINCT FROM NEW.content THEN changed := array_append(changed, 'content'); END IF;
    IF OLD.metadata IS DISTINCT FROM NEW.metadata THEN changed := array_append(changed, 'metadata'); END IF;
    IF OLD.scope IS DISTINCT FROM NEW.scope THEN changed := array_append(changed, 'scope'); END IF;
    INSERT INTO memory_events (
      id, workspace_id, owner_user_id, memory_scope,
      resource_type, resource_id, event_type,
      actor_user_id, actor_agent_id, request_id,
      before_version, after_version, changed_fields,
      before_content_sha256, after_content_sha256
    ) VALUES (
      gen_random_uuid(), NEW.workspace_id, NEW.owner_user_id, NEW.scope,
      'memory', NEW.id, 'memory.updated',
      lore.current_user_id(), lore.current_agent_id(), lore.current_request_id(),
      OLD.version, NEW.version, changed,
      encode(sha256(convert_to(OLD.content, 'UTF8')), 'hex'),
      encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex')
    );
    RETURN NEW;
  END IF;

  -- A hard delete invalidates earlier replay bodies for this Memory so the
  -- idempotency ledger cannot retain deleted user content for its remaining TTL.
  DELETE FROM request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id
    AND replay.response_body #>> '{memory,id}' = OLD.id::text;

  INSERT INTO memory_events (
    id, workspace_id, owner_user_id, memory_scope,
    resource_type, resource_id, event_type,
    actor_user_id, actor_agent_id, request_id,
    before_version, changed_fields, before_content_sha256,
    expires_at
  ) VALUES (
    gen_random_uuid(), OLD.workspace_id, OLD.owner_user_id, OLD.scope,
    'memory', OLD.id, 'memory.deleted',
    lore.current_user_id(), lore.current_agent_id(), lore.current_request_id(),
    OLD.version, ARRAY['content', 'metadata', 'scope'],
    encode(sha256(convert_to(OLD.content, 'UTF8')), 'hex'),
    now() + interval '30 days'
  );
  RETURN OLD;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.append_memory_link_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  link_row memory_links%ROWTYPE;
  source_owner uuid;
  source_scope memory_scope;
  changed text[] := ARRAY[]::text[];
BEGIN
  link_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  SELECT memory.owner_user_id, memory.scope
  INTO source_owner, source_scope
  FROM memories memory
  WHERE memory.workspace_id = link_row.workspace_id
    AND memory.id = link_row.source_memory_id;

  IF source_owner IS NULL THEN
    RETURN link_row;
  END IF;

  IF TG_OP = 'INSERT' THEN
    changed := ARRAY['endpoints', 'kind', 'metadata', 'weight'];
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.kind IS DISTINCT FROM NEW.kind THEN changed := array_append(changed, 'kind'); END IF;
    IF OLD.metadata IS DISTINCT FROM NEW.metadata THEN changed := array_append(changed, 'metadata'); END IF;
    IF OLD.weight IS DISTINCT FROM NEW.weight THEN changed := array_append(changed, 'weight'); END IF;
  ELSE
    changed := ARRAY['endpoints', 'kind', 'metadata', 'weight'];
  END IF;

  INSERT INTO memory_events (
    id, workspace_id, owner_user_id, memory_scope,
    resource_type, resource_id, source_memory_id, related_memory_id, event_type,
    actor_user_id, actor_agent_id, request_id, changed_fields,
    expires_at
  ) VALUES (
    gen_random_uuid(), link_row.workspace_id, source_owner, source_scope,
    'memory_link', link_row.id, link_row.source_memory_id, link_row.target_memory_id,
    CASE TG_OP
      WHEN 'INSERT' THEN 'memory_link.created'
      WHEN 'UPDATE' THEN 'memory_link.updated'
      ELSE 'memory_link.deleted'
    END,
    lore.current_user_id(), lore.current_agent_id(), lore.current_request_id(), changed,
    CASE WHEN TG_OP = 'DELETE' THEN now() + interval '30 days' ELSE now() + interval '90 days' END
  );
  RETURN link_row;
END
$$;
--> statement-breakpoint


CREATE TRIGGER memories_append_event_insert_update
AFTER INSERT OR UPDATE ON memories
FOR EACH ROW EXECUTE FUNCTION lore.append_memory_event();
--> statement-breakpoint


CREATE TRIGGER memories_append_event_delete
BEFORE DELETE ON memories
FOR EACH ROW EXECUTE FUNCTION lore.append_memory_event();
--> statement-breakpoint


CREATE TRIGGER memory_links_append_event_insert_update
AFTER INSERT OR UPDATE ON memory_links
FOR EACH ROW EXECUTE FUNCTION lore.append_memory_link_event();
--> statement-breakpoint


CREATE TRIGGER memory_links_append_event_delete
BEFORE DELETE ON memory_links
FOR EACH ROW EXECUTE FUNCTION lore.append_memory_link_event();
--> statement-breakpoint


CREATE FUNCTION lore.ensure_embedding_generation(
  target_provider text,
  target_model text,
  target_dimensions integer,
  target_revision text
)
RETURNS TABLE (id uuid, status embedding_generation_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  initial_status embedding_generation_status;
BEGIN
  IF btrim(target_provider) = '' OR btrim(target_model) = '' OR btrim(target_revision) = '' THEN
    RAISE EXCEPTION 'Embedding generation identity is required';
  END IF;
  IF target_dimensions <> 1024 THEN
    RAISE EXCEPTION 'Lore v1 embedding generations require 1024 dimensions';
  END IF;

  RETURN QUERY
  SELECT generation.id, generation.status
  FROM embedding_generations generation
  WHERE generation.embedding_provider = target_provider
    AND generation.embedding_model = target_model
    AND generation.embedding_dimensions = target_dimensions
    AND generation.embedding_revision = target_revision;
  IF FOUND THEN RETURN; END IF;

  -- Serialize first-generation creation. Otherwise two different identities can
  -- both select `active`, and the loser of the one-active unique constraint has
  -- no matching row to return to its caller.
  LOCK TABLE embedding_generations IN SHARE ROW EXCLUSIVE MODE;

  initial_status := CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM embedding_generations active_generation
      WHERE active_generation.status = 'active'
    )
      THEN 'active'::embedding_generation_status
    ELSE 'building'::embedding_generation_status
  END;

  BEGIN
    INSERT INTO embedding_generations (
      id, embedding_provider, embedding_model, embedding_dimensions,
      embedding_revision, status, activated_at
    ) VALUES (
      gen_random_uuid(), target_provider, target_model, target_dimensions,
      target_revision, initial_status,
      CASE WHEN initial_status = 'active' THEN now() ELSE NULL END
    );
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  RETURN QUERY
  SELECT generation.id, generation.status
  FROM embedding_generations generation
  WHERE generation.embedding_provider = target_provider
    AND generation.embedding_model = target_model
    AND generation.embedding_dimensions = target_dimensions
    AND generation.embedding_revision = target_revision;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.current_maintenance_generation_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT job.generation_id
  FROM memory_embedding_jobs job
  WHERE job.id = lore.current_maintenance_job_id()
    AND job.lease_token = lore.current_maintenance_lease_token()
    AND job.status = 'processing'
$$;
--> statement-breakpoint


CREATE FUNCTION lore.lock_current_maintenance_memory()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  locked_memory_id uuid;
BEGIN
  SELECT memory.id INTO locked_memory_id
  FROM memory_embedding_jobs job
  JOIN memories memory
    ON memory.workspace_id = job.workspace_id
   AND memory.id = job.memory_id
   AND memory.owner_user_id = job.owner_user_id
   AND memory.scope = job.memory_scope
   AND memory.version = job.memory_version
  WHERE job.id = lore.current_maintenance_job_id()
    AND job.lease_token = lore.current_maintenance_lease_token()
    AND job.status = 'processing'
  FOR KEY SHARE OF memory;

  RETURN locked_memory_id IS NOT NULL;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.can_maintain_embedding(
  target_generation_id uuid,
  target_workspace_id uuid,
  target_memory_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT target_generation_id = lore.current_maintenance_generation_id()
    AND lore.can_maintain_memory(target_workspace_id, target_memory_id)
$$;
--> statement-breakpoint


CREATE OR REPLACE FUNCTION lore.claim_memory_embedding_job(
  requested_job_id uuid,
  active_embedding_provider text,
  active_embedding_model text,
  active_embedding_revision text,
  new_lease_token uuid,
  lease_timeout_seconds integer
)
RETURNS TABLE (
  id uuid,
  workspace_id uuid,
  memory_id uuid,
  owner_user_id uuid,
  memory_scope memory_scope,
  memory_version integer,
  attempt_count smallint,
  chunks jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_generation_id uuid;
BEGIN
  IF lease_timeout_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'Lease timeout must be between 30 and 3600 seconds';
  END IF;

  IF requested_job_id IS NULL THEN
    SELECT generation.id INTO target_generation_id
    FROM lore.ensure_embedding_generation(
      active_embedding_provider,
      active_embedding_model,
      1024,
      active_embedding_revision
    ) generation;
  ELSE
    -- Queue hints may arrive after rollback retention has deleted their job and
    -- generation. Resolve an existing identity instead of recreating an empty
    -- building generation. Lock generation before job, matching retention prune
    -- and embedding completion, so their transactions cannot deadlock.
    SELECT job.generation_id INTO target_generation_id
    FROM memory_embedding_jobs job
    WHERE job.id = requested_job_id;
    IF target_generation_id IS NULL THEN
      RETURN;
    END IF;

    PERFORM generation.id
    FROM embedding_generations generation
    WHERE generation.id = target_generation_id
      AND generation.embedding_provider = active_embedding_provider
      AND generation.embedding_model = active_embedding_model
      AND generation.embedding_dimensions = 1024
      AND generation.embedding_revision = active_embedding_revision
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RETURN;
    END IF;

    PERFORM job.id
    FROM memory_embedding_jobs job
    WHERE job.id = requested_job_id
      AND job.generation_id = target_generation_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN;
    END IF;
  END IF;

  UPDATE memory_embedding_jobs job
  SET status = 'cancelled', lease_token = NULL, leased_at = NULL,
      completed_at = now(), updated_at = now()
  FROM memories memory
  WHERE memory.workspace_id = job.workspace_id
    AND memory.id = job.memory_id
    AND (
      memory.version <> job.memory_version
      OR memory.owner_user_id <> job.owner_user_id
      OR memory.scope <> job.memory_scope
    )
    AND job.id = requested_job_id
    AND job.status IN ('pending', 'processing');

  UPDATE memory_embedding_jobs job
  SET status = 'dead', lease_token = NULL, leased_at = NULL,
      last_error = COALESCE(job.last_error, 'Embedding job lease expired'),
      completed_at = now(), updated_at = now()
  WHERE job.status = 'processing'
    AND job.id = requested_job_id
    AND job.leased_at <= now() - lease_timeout_seconds * interval '1 second'
    AND job.attempt_count >= job.max_attempts;

  RETURN QUERY
  WITH candidate AS (
    SELECT job.id
    FROM memory_embedding_jobs job
    JOIN memories memory
      ON memory.workspace_id = job.workspace_id
     AND memory.id = job.memory_id
     AND memory.owner_user_id = job.owner_user_id
     AND memory.scope = job.memory_scope
     AND memory.version = job.memory_version
    WHERE (requested_job_id IS NULL OR job.id = requested_job_id)
      AND job.generation_id = target_generation_id
      AND job.attempt_count < job.max_attempts
      AND (
        (job.status = 'pending' AND job.available_at <= now())
        OR (
          job.status = 'processing'
          AND job.leased_at <= now() - lease_timeout_seconds * interval '1 second'
        )
      )
    ORDER BY job.available_at, job.created_at, job.id
    FOR UPDATE OF job SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE memory_embedding_jobs job
    SET status = 'processing', attempt_count = job.attempt_count + 1,
        lease_token = new_lease_token, leased_at = now(), completed_at = NULL,
        updated_at = now()
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.*
  )
  SELECT
    claimed.id,
    claimed.workspace_id,
    claimed.memory_id,
    claimed.owner_user_id,
    claimed.memory_scope,
    claimed.memory_version,
    claimed.attempt_count,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', chunk.id,
          'ordinal', chunk.ordinal,
          'content', chunk.content
        ) ORDER BY chunk.ordinal, chunk.id
      ) FILTER (WHERE chunk.id IS NOT NULL),
      '[]'::jsonb
    )
  FROM claimed
  LEFT JOIN memory_chunks chunk
    ON chunk.workspace_id = claimed.workspace_id
   AND chunk.memory_id = claimed.memory_id
  GROUP BY
    claimed.id, claimed.workspace_id, claimed.memory_id, claimed.owner_user_id,
    claimed.memory_scope, claimed.memory_version, claimed.attempt_count;
END
$$;
--> statement-breakpoint


CREATE OR REPLACE FUNCTION lore.enqueue_stale_memory_embedding_jobs(
  active_embedding_provider text,
  active_embedding_model text,
  active_embedding_revision text,
  job_limit integer
)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_generation_id uuid;
  terminal_job_ids uuid[];
  stale_job_ids uuid[];
  reconcile_job_ids uuid[];
  candidate_memory_ids uuid[];
  target_job_id uuid;
  target_memory_id uuid;
BEGIN
  IF job_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Job limit must be between 1 and 10000';
  END IF;

  SELECT generation.id INTO target_generation_id
  FROM embedding_generations generation
  WHERE generation.embedding_provider = active_embedding_provider
    AND generation.embedding_model = active_embedding_model
    AND generation.embedding_dimensions = 1024
    AND generation.embedding_revision = active_embedding_revision;

  SELECT COALESCE(array_agg(candidate.id ORDER BY candidate.id), ARRAY[]::uuid[])
  INTO terminal_job_ids
  FROM (
    SELECT job.id
    FROM memory_embedding_jobs job
    WHERE (job.status IN ('succeeded', 'cancelled')
        AND job.completed_at < now() - interval '7 days')
       OR (job.status = 'dead' AND job.completed_at < now() - interval '30 days')
    ORDER BY job.id
    LIMIT job_limit
  ) candidate;

  SELECT COALESCE(array_agg(candidate.id ORDER BY candidate.id), ARRAY[]::uuid[])
  INTO stale_job_ids
  FROM (
    SELECT job.id
    FROM memory_embedding_jobs job
    JOIN memories memory
      ON memory.workspace_id = job.workspace_id
     AND memory.id = job.memory_id
    WHERE (
      job.status IN ('pending', 'processing', 'dead')
      AND (
        memory.version <> job.memory_version
        OR memory.owner_user_id <> job.owner_user_id
        OR memory.scope <> job.memory_scope
      )
    ) OR (
      job.status = 'processing'
      AND job.attempt_count >= job.max_attempts
      AND job.leased_at <= now() - interval '1 hour'
    ) OR (
      job.generation_id IS NULL
      AND job.embedding_provider = active_embedding_provider
      AND job.embedding_model = active_embedding_model
      AND job.embedding_revision = active_embedding_revision
    )
    ORDER BY job.id
    LIMIT job_limit
  ) candidate;

  SELECT COALESCE(array_agg(DISTINCT candidate.id ORDER BY candidate.id), ARRAY[]::uuid[])
  INTO reconcile_job_ids
  FROM unnest(terminal_job_ids || stale_job_ids) candidate(id);

  SELECT COALESCE(array_agg(candidate.id ORDER BY candidate.id), ARRAY[]::uuid[])
  INTO candidate_memory_ids
  FROM (
    SELECT memory.id
    FROM memories memory
    WHERE EXISTS (
      SELECT 1
      FROM memory_chunks chunk
      WHERE chunk.workspace_id = memory.workspace_id
        AND chunk.memory_id = memory.id
        AND (
          target_generation_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM memory_chunk_embeddings embedded
            WHERE embedded.generation_id = target_generation_id
              AND embedded.chunk_id = chunk.id
          )
        )
    )
      AND (
        target_generation_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM memory_embedding_jobs existing_job
          WHERE existing_job.workspace_id = memory.workspace_id
            AND existing_job.memory_id = memory.id
            AND existing_job.memory_version = memory.version
            AND existing_job.generation_id = target_generation_id
            AND existing_job.status IN ('pending', 'processing', 'dead')
        )
      )
    ORDER BY memory.updated_at, memory.id
    LIMIT job_limit
  ) candidate;

  -- Request writes lock the parent Memory before chunks, generations, and jobs.
  -- Discover bounded ids without locks, then lock every affected parent in one
  -- deterministic order before touching any generation or job row.
  PERFORM memory.id
  FROM memories memory
  WHERE memory.id = ANY(candidate_memory_ids)
    OR EXISTS (
      SELECT 1
      FROM memory_embedding_jobs job
      WHERE job.workspace_id = memory.workspace_id
        AND job.memory_id = memory.id
        AND job.id = ANY(reconcile_job_ids)
    )
  ORDER BY memory.id
  FOR KEY SHARE;

  SELECT generation.id INTO target_generation_id
  FROM lore.ensure_embedding_generation(
    active_embedding_provider,
    active_embedding_model,
    1024,
    active_embedding_revision
  ) generation;

  -- Retention locks generation before jobs. Hold the target generation before
  -- bounded terminal/stale-job cleanup so seed and prune cannot invert that order.
  PERFORM generation.id
  FROM embedding_generations generation
  WHERE generation.id = target_generation_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  FOREACH target_job_id IN ARRAY reconcile_job_ids LOOP
    DELETE FROM memory_embedding_jobs job
    WHERE job.id = target_job_id
      AND (
        (job.status IN ('succeeded', 'cancelled')
          AND job.completed_at < now() - interval '7 days')
        OR (job.status = 'dead' AND job.completed_at < now() - interval '30 days')
      );
    IF NOT FOUND THEN
      -- Migration 0003 is additive so an older application instance may still
      -- enqueue without generation_id during a rolling deployment. Adopt that
      -- job in place without changing its valid status, lease, or completion
      -- fields; the ordinary stale-state recheck below still handles an obsolete
      -- Memory identity or an exhausted processing lease in the same sweep.
      UPDATE memory_embedding_jobs job
      SET generation_id = target_generation_id,
          updated_at = now()
      WHERE job.id = target_job_id
        AND job.generation_id IS NULL
        AND job.embedding_provider = active_embedding_provider
        AND job.embedding_model = active_embedding_model
        AND job.embedding_revision = active_embedding_revision;

      UPDATE memory_embedding_jobs job
      SET status = CASE
            WHEN memory.version <> job.memory_version
              OR memory.owner_user_id <> job.owner_user_id
              OR memory.scope <> job.memory_scope
              THEN 'cancelled'::memory_embedding_job_status
            ELSE 'dead'::memory_embedding_job_status
          END,
          lease_token = NULL, leased_at = NULL,
          last_error = CASE
            WHEN memory.version <> job.memory_version
              OR memory.owner_user_id <> job.owner_user_id
              OR memory.scope <> job.memory_scope
              THEN job.last_error
            ELSE COALESCE(job.last_error, 'Embedding job lease expired')
          END,
          completed_at = now(), updated_at = now()
      FROM memories memory
      WHERE job.id = target_job_id
        AND memory.workspace_id = job.workspace_id
        AND memory.id = job.memory_id
        AND (
          (
            job.status IN ('pending', 'processing', 'dead')
            AND (
              memory.version <> job.memory_version
              OR memory.owner_user_id <> job.owner_user_id
              OR memory.scope <> job.memory_scope
            )
          ) OR (
            job.status = 'processing'
            AND job.attempt_count >= job.max_attempts
            AND job.leased_at <= now() - interval '1 hour'
          )
        );
    END IF;
  END LOOP;

  FOREACH target_memory_id IN ARRAY candidate_memory_ids LOOP
    RETURN QUERY
    INSERT INTO memory_embedding_jobs (
      id, workspace_id, memory_id, owner_user_id, memory_scope, memory_version,
      embedding_provider, embedding_model, embedding_revision, generation_id
    )
    SELECT
      gen_random_uuid(), memory.workspace_id, memory.id,
      memory.owner_user_id, memory.scope, memory.version,
      active_embedding_provider, active_embedding_model, active_embedding_revision,
      target_generation_id
    FROM memories memory
    WHERE memory.id = target_memory_id
      AND EXISTS (
        SELECT 1
        FROM memory_chunks chunk
        WHERE chunk.workspace_id = memory.workspace_id
          AND chunk.memory_id = memory.id
          AND NOT EXISTS (
            SELECT 1
            FROM memory_chunk_embeddings embedded
            WHERE embedded.generation_id = target_generation_id
              AND embedded.chunk_id = chunk.id
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM memory_embedding_jobs existing_job
        WHERE existing_job.workspace_id = memory.workspace_id
          AND existing_job.memory_id = memory.id
          AND existing_job.memory_version = memory.version
          AND existing_job.generation_id = target_generation_id
          AND existing_job.status IN ('pending', 'processing', 'dead')
      )
    ON CONFLICT (
      workspace_id, memory_id, memory_version,
      embedding_provider, embedding_model, embedding_revision
    ) DO UPDATE
    SET status = 'pending', attempt_count = 0, available_at = now(),
        lease_token = NULL, leased_at = NULL, last_error = NULL,
        completed_at = NULL, generation_id = target_generation_id, updated_at = now()
    WHERE memory_embedding_jobs.status IN ('succeeded', 'cancelled')
    RETURNING memory_embedding_jobs.id;
  END LOOP;
END
$$;
--> statement-breakpoint


CREATE OR REPLACE FUNCTION lore.list_pending_memory_embedding_jobs(
  active_embedding_provider text,
  active_embedding_model text,
  active_embedding_revision text,
  lease_timeout_seconds integer,
  job_limit integer
)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT job.id
  FROM memory_embedding_jobs job
  JOIN embedding_generations generation ON generation.id = job.generation_id
  JOIN memories memory
    ON memory.workspace_id = job.workspace_id
   AND memory.id = job.memory_id
   AND memory.owner_user_id = job.owner_user_id
   AND memory.scope = job.memory_scope
   AND memory.version = job.memory_version
  WHERE generation.embedding_provider = active_embedding_provider
    AND generation.embedding_model = active_embedding_model
    AND generation.embedding_revision = active_embedding_revision
    AND job.attempt_count < job.max_attempts
    AND (
      (job.status = 'pending' AND job.available_at <= now())
      OR (
        job.status = 'processing'
        AND job.leased_at <= now() - lease_timeout_seconds * interval '1 second'
      )
    )
  ORDER BY job.available_at, job.created_at, job.id
  LIMIT job_limit
$$;
--> statement-breakpoint


CREATE FUNCTION lore.embedding_generation_report(
  target_provider text,
  target_model text,
  target_revision text
)
RETURNS TABLE (
  id uuid,
  status embedding_generation_status,
  eligible_chunks bigint,
  embedded_chunks bigint,
  missing_chunks bigint,
  pending_jobs bigint,
  dead_jobs bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    generation.id,
    generation.status,
    (SELECT count(*) FROM memory_chunks),
    (
      SELECT count(*)
      FROM memory_chunk_embeddings embedded
      JOIN memory_chunks chunk ON chunk.id = embedded.chunk_id
      WHERE embedded.generation_id = generation.id
    ),
    (
      SELECT count(*)
      FROM memory_chunks chunk
      WHERE NOT EXISTS (
        SELECT 1
        FROM memory_chunk_embeddings embedded
        WHERE embedded.generation_id = generation.id
          AND embedded.chunk_id = chunk.id
      )
    ),
    (
      SELECT count(*)
      FROM memory_embedding_jobs job
      WHERE job.generation_id = generation.id
        AND job.status IN ('pending', 'processing')
    ),
    (
      SELECT count(*)
      FROM memory_embedding_jobs job
      WHERE job.generation_id = generation.id
        AND job.status = 'dead'
    )
  FROM embedding_generations generation
  WHERE generation.embedding_provider = target_provider
    AND generation.embedding_model = target_model
    AND generation.embedding_dimensions = 1024
    AND generation.embedding_revision = target_revision
$$;
--> statement-breakpoint


CREATE FUNCTION lore.activate_embedding_generation(
  target_provider text,
  target_model text,
  target_revision text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_generation_id uuid;
  missing_count bigint;
  unfinished_count bigint;
  dead_count bigint;
BEGIN
  -- Serialize the coverage snapshot with canonical chunk mutations. Memory
  -- writes acquire their memory_chunks lock before ensuring a generation, so
  -- this order also avoids crossing the write-path lock order.
  LOCK TABLE memory_chunks IN SHARE MODE;
  LOCK TABLE embedding_generations IN SHARE ROW EXCLUSIVE MODE;

  SELECT generation.id INTO target_generation_id
  FROM embedding_generations generation
  WHERE generation.embedding_provider = target_provider
    AND generation.embedding_model = target_model
    AND generation.embedding_dimensions = 1024
    AND generation.embedding_revision = target_revision;
  IF target_generation_id IS NULL THEN RAISE EXCEPTION 'Embedding generation does not exist'; END IF;

  SELECT count(*) INTO missing_count
  FROM memory_chunks chunk
  WHERE NOT EXISTS (
    SELECT 1 FROM memory_chunk_embeddings embedded
    WHERE embedded.generation_id = target_generation_id
      AND embedded.chunk_id = chunk.id
  );
  SELECT count(*) INTO unfinished_count
  FROM memory_embedding_jobs job
  WHERE job.generation_id = target_generation_id
    AND job.status IN ('pending', 'processing');
  SELECT count(*) INTO dead_count
  FROM memory_embedding_jobs job
  WHERE job.generation_id = target_generation_id
    AND job.status = 'dead';

  IF missing_count > 0 OR unfinished_count > 0 OR dead_count > 0 THEN
    RAISE EXCEPTION 'Embedding generation is not ready (missing %, unfinished %, dead %)',
      missing_count, unfinished_count, dead_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM embedding_generations
    WHERE id = target_generation_id AND status = 'active'
  ) THEN
    RETURN target_generation_id;
  END IF;

  UPDATE embedding_generations
  SET status = 'retiring', retired_at = now()
  WHERE status = 'active';

  UPDATE embedding_generations
  SET status = 'active', activated_at = now(), retired_at = NULL,
      validated_at = now(), failure_detail = NULL
  WHERE id = target_generation_id;

  RETURN target_generation_id;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.purge_expired_portable_core_records()
RETURNS TABLE (idempotency_records bigint, memory_event_records bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  idempotency_count bigint;
  event_count bigint;
BEGIN
  DELETE FROM request_idempotency_records WHERE expires_at <= now();
  GET DIAGNOSTICS idempotency_count = ROW_COUNT;
  DELETE FROM memory_events WHERE expires_at <= now();
  GET DIAGNOSTICS event_count = ROW_COUNT;
  RETURN QUERY SELECT idempotency_count, event_count;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.prune_retiring_embedding_generations(
  retention_seconds integer DEFAULT 604800
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  pruned_count bigint;
BEGIN
  IF retention_seconds < 3600 THEN
    RAISE EXCEPTION 'Embedding rollback retention must be at least one hour';
  END IF;

  -- Completion obtains a generation FK lock before it updates its job. Take the
  -- same generation -> job order here so a late completion and retention sweep
  -- serialize instead of deadlocking. Activation already uses this table lock;
  -- acquire it before any row lock so activation and prune cannot deadlock while
  -- upgrading a delete's table lock.
  LOCK TABLE embedding_generations IN SHARE ROW EXCLUSIVE MODE;

  PERFORM generation.id
  FROM embedding_generations generation
  WHERE generation.status = 'retiring'
    AND generation.retired_at <= now() - retention_seconds * interval '1 second'
  ORDER BY generation.id
  FOR UPDATE;

  -- A retired generation is no longer claimed by the active deployment. Cancel
  -- work that never started, plus processing work whose lease has exceeded the
  -- maximum one-hour lease accepted by claim_memory_embedding_job. A worker with
  -- a still-valid lease keeps the generation alive until a later sweep.
  UPDATE memory_embedding_jobs job
  SET status = 'cancelled', lease_token = NULL, leased_at = NULL,
      last_error = COALESCE(job.last_error, 'Embedding generation retention expired'),
      completed_at = now(), updated_at = now()
  FROM embedding_generations generation
  WHERE generation.id = job.generation_id
    AND generation.status = 'retiring'
    AND generation.retired_at <= now() - retention_seconds * interval '1 second'
    AND (
      job.status = 'pending'
      OR (
        job.status = 'processing'
        AND job.leased_at <= now() - interval '1 hour'
      )
    );

  DELETE FROM memory_embedding_jobs job
  USING embedding_generations generation
  WHERE generation.id = job.generation_id
    AND generation.status = 'retiring'
    AND generation.retired_at <= now() - retention_seconds * interval '1 second'
    AND job.status IN ('succeeded', 'dead', 'cancelled');

  DELETE FROM embedding_generations generation
  WHERE generation.status = 'retiring'
    AND generation.retired_at <= now() - retention_seconds * interval '1 second'
    AND NOT EXISTS (
      SELECT 1
      FROM memory_embedding_jobs job
      WHERE job.generation_id = generation.id
    );
  GET DIAGNOSTICS pruned_count = ROW_COUNT;
  RETURN pruned_count;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.portable_core_capabilities()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'apiVersion', state.api_version,
    'schemaRevision', state.schema_revision,
    'deploymentId', state.deployment_id,
    'features', jsonb_build_object(
      'idempotency', true,
      'optimisticConcurrency', true,
      'transactionalOutbox', true,
      'workspacePortability', true,
      'embeddingGenerations', true,
      'cursorPagination', true
    ),
    'limits', jsonb_build_object(
      'workspaceArchiveMemories', 10000,
      'workspaceArchiveLinks', 50000
    ),
    'activeEmbeddingGeneration', (
      SELECT jsonb_build_object(
        'provider', generation.embedding_provider,
        'model', generation.embedding_model,
        'dimensions', generation.embedding_dimensions,
        'revision', generation.embedding_revision
      )
      FROM embedding_generations generation
      WHERE generation.status = 'active'
    )
  )
  FROM lore_system_state state
  WHERE state.singleton
$$;
--> statement-breakpoint


ALTER TABLE request_idempotency_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE memory_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE embedding_generations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE memory_chunk_embeddings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE workspace_imports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE memory_import_provenance ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint


CREATE POLICY request_idempotency_records_all ON request_idempotency_records
  FOR ALL
  TO lore_app
  USING (
    workspace_id = lore.current_workspace_id()
    AND actor_user_id = lore.current_user_id()
    AND actor_kind = CASE WHEN lore.current_agent_id() IS NULL THEN 'user' ELSE 'agent' END
    AND actor_id = COALESCE(lore.current_agent_id(), lore.current_user_id())
  )
  WITH CHECK (
    workspace_id = lore.current_workspace_id()
    AND actor_user_id = lore.current_user_id()
    AND actor_kind = CASE WHEN lore.current_agent_id() IS NULL THEN 'user' ELSE 'agent' END
    AND actor_id = COALESCE(lore.current_agent_id(), lore.current_user_id())
  );
--> statement-breakpoint


CREATE POLICY memory_events_select ON memory_events
  FOR SELECT
  TO lore_app
  USING (
    (
      resource_type = 'memory'
      AND (
        EXISTS (
          SELECT 1
          FROM memories memory
          WHERE memory.workspace_id = memory_events.workspace_id
            AND memory.id = memory_events.resource_id
            AND lore.can_read_memory(
              memory.workspace_id,
              memory.owner_user_id,
              memory.scope
            )
        )
        OR (
          event_type = 'memory.deleted'
          AND lore.can_read_memory(workspace_id, owner_user_id, memory_scope)
        )
      )
    )
    OR (
      resource_type = 'memory_link'
      AND EXISTS (
        SELECT 1
        FROM memories source_memory
        JOIN memories target_memory
          ON target_memory.workspace_id = source_memory.workspace_id
         AND target_memory.id = memory_events.related_memory_id
        WHERE source_memory.workspace_id = memory_events.workspace_id
          AND source_memory.id = memory_events.source_memory_id
          AND lore.can_read_memory(
            source_memory.workspace_id,
            source_memory.owner_user_id,
            source_memory.scope
          )
          AND lore.can_read_memory(
            target_memory.workspace_id,
            target_memory.owner_user_id,
            target_memory.scope
          )
      )
    )
  );
--> statement-breakpoint


CREATE POLICY memory_chunk_embeddings_select ON memory_chunk_embeddings
  FOR SELECT
  TO lore_app
  USING (
    EXISTS (
      SELECT 1
      FROM embedding_generations generation
      JOIN memories memory
        ON memory.workspace_id = memory_chunk_embeddings.workspace_id
       AND memory.id = memory_chunk_embeddings.memory_id
      WHERE generation.id = memory_chunk_embeddings.generation_id
        AND generation.status IN ('active', 'retiring')
        AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)
    )
  );
--> statement-breakpoint


CREATE POLICY embedding_generations_select ON embedding_generations
  FOR SELECT
  TO lore_app
  USING (status IN ('active', 'retiring'));
--> statement-breakpoint


CREATE POLICY memory_chunk_embeddings_delete ON memory_chunk_embeddings
  FOR DELETE
  TO lore_app
  USING (
    EXISTS (
      SELECT 1
      FROM memories memory
      WHERE memory.workspace_id = memory_chunk_embeddings.workspace_id
        AND memory.id = memory_chunk_embeddings.memory_id
        AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)
    )
  );
--> statement-breakpoint


CREATE POLICY memory_chunk_embeddings_maintenance_all ON memory_chunk_embeddings
  FOR ALL
  TO lore_maintenance
  USING (lore.can_maintain_embedding(generation_id, workspace_id, memory_id))
  WITH CHECK (lore.can_maintain_embedding(generation_id, workspace_id, memory_id));
--> statement-breakpoint


CREATE POLICY workspace_imports_all ON workspace_imports
  FOR ALL
  TO lore_app
  USING (
    workspace_id = lore.current_workspace_id()
    AND imported_by_user_id = lore.current_user_id()
    AND lore.current_agent_id() IS NULL
    AND lore.is_active_member(workspace_id)
  )
  WITH CHECK (
    workspace_id = lore.current_workspace_id()
    AND imported_by_user_id = lore.current_user_id()
    AND lore.current_agent_id() IS NULL
    AND lore.is_active_member(workspace_id)
  );
--> statement-breakpoint


CREATE POLICY memory_import_provenance_select ON memory_import_provenance
  FOR SELECT
  TO lore_app
  USING (
    EXISTS (
      SELECT 1 FROM memories memory
      WHERE memory.workspace_id = memory_import_provenance.workspace_id
        AND memory.id = memory_import_provenance.memory_id
        AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)
    )
  );
--> statement-breakpoint


CREATE POLICY memory_import_provenance_insert ON memory_import_provenance
  FOR INSERT
  TO lore_app
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memories memory
      WHERE memory.workspace_id = memory_import_provenance.workspace_id
        AND memory.id = memory_import_provenance.memory_id
        AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)
    )
  );
--> statement-breakpoint


REVOKE ALL ON FUNCTION lore.current_request_id() FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.append_memory_event() FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.append_memory_link_event() FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.ensure_embedding_generation(text, text, integer, text) FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.current_maintenance_generation_id() FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.lock_current_maintenance_memory() FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.can_maintain_embedding(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.embedding_generation_report(text, text, text) FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.activate_embedding_generation(text, text, text) FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.purge_expired_portable_core_records() FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.prune_retiring_embedding_generations(integer) FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.portable_core_capabilities() FROM PUBLIC;
--> statement-breakpoint


GRANT SELECT, INSERT, UPDATE ON request_idempotency_records TO lore_app;
--> statement-breakpoint

GRANT SELECT ON memory_events TO lore_app;
--> statement-breakpoint

GRANT SELECT ON embedding_generations TO lore_app;
--> statement-breakpoint

GRANT SELECT, DELETE ON memory_chunk_embeddings TO lore_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON workspace_imports TO lore_app;
--> statement-breakpoint

GRANT SELECT, INSERT ON memory_import_provenance TO lore_app;
--> statement-breakpoint

GRANT INSERT, UPDATE, DELETE, SELECT ON memory_chunk_embeddings TO lore_maintenance;
--> statement-breakpoint


GRANT EXECUTE ON FUNCTION lore.current_request_id() TO lore_app;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.ensure_embedding_generation(text, text, integer, text)
  TO lore_app, lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.current_maintenance_generation_id() TO lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.lock_current_maintenance_memory() TO lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.can_maintain_embedding(uuid, uuid, uuid) TO lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.embedding_generation_report(text, text, text) TO lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.activate_embedding_generation(text, text, text) TO lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.purge_expired_portable_core_records() TO lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.prune_retiring_embedding_generations(integer)
  TO lore_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.portable_core_capabilities() TO lore_app, lore_maintenance;
--> statement-breakpoint


COMMENT ON TABLE request_idempotency_records IS
  'Actor-scoped replay ledger; request payloads are represented only by SHA-256 hashes.';
--> statement-breakpoint

COMMENT ON TABLE memory_events IS
  'Content-free transactional mutation outbox and bounded deletion tombstones.';
--> statement-breakpoint

COMMENT ON TABLE memory_chunk_embeddings IS
  'Generation-scoped vectors; incompatible spaces are never searched together.';
--> statement-breakpoint



-- Lore legacy migration 0004_english_lexical_search.sql
ALTER TABLE memory_chunks
  ADD COLUMN search_vector_english tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
--> statement-breakpoint


CREATE INDEX memory_chunks_search_english_idx
  ON memory_chunks USING gin (search_vector_english);
--> statement-breakpoint


DO $$
BEGIN
  UPDATE lore_system_state
  SET schema_revision = 4, updated_at = now()
  WHERE singleton AND schema_revision = 3;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected Lore schema revision 3 before migration 0004';
  END IF;
END
$$;
--> statement-breakpoint



-- Lore legacy migration 0005_memory_metadata_search.sql
CREATE INDEX memories_metadata_gin_idx
  ON memories USING gin (metadata jsonb_path_ops);
--> statement-breakpoint


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
--> statement-breakpoint



-- Lore legacy migration 0006_memory_chunk_entity_aliases.sql
CREATE FUNCTION lore.extract_entity_aliases(input text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  WITH raw_aliases(raw_alias) AS (
    SELECT match[1]
    FROM regexp_matches(
      input,
      '"([^"[:cntrl:]]{2,128})"',
      'g'
    ) AS match

    UNION ALL

    SELECT match[1]
    FROM regexp_matches(
      input,
      '([[:upper:]][[:alnum:]_.''’:-]*(?:[[:space:]]+(?:(?:of|the|and|for|de|da|del|van|von|la|le)[[:space:]]+)?[[:upper:]][[:alnum:]_.''’:-]*)*)',
      'g'
    ) AS match

    UNION ALL

    SELECT match[1]
    FROM regexp_matches(
      input,
      '([[:upper:]][[:alnum:]_.''’:-]+)',
      'g'
    ) AS match

    UNION ALL

    SELECT match[1]
    FROM regexp_matches(
      input,
      '([[:alnum:]_./:#-]*[[:digit:]][[:alnum:]_./:#-]*)',
      'g'
    ) AS match
  ),
  normalized(alias) AS (
    SELECT lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(btrim(raw_alias), '[[:space:]]+', ' ', 'g'),
          '^[^[:alnum:]]+',
          ''
        ),
        '[^[:alnum:]]+$',
        ''
      )
    )
    FROM raw_aliases
  ),
  bounded AS (
    SELECT
      alias,
      cardinality(regexp_split_to_array(alias, '[[:space:]]+')) AS word_count,
      char_length(alias) AS alias_length
    FROM normalized
    WHERE char_length(alias) BETWEEN 2 AND 128
      AND alias ~ '[[:alpha:]]'
      AND alias NOT IN (
        'a', 'an', 'are', 'at', 'can', 'could', 'did', 'do', 'does', 'for',
        'from', 'had', 'has', 'have', 'how', 'in', 'is', 'may', 'might', 'of',
        'on', 'should', 'that', 'the', 'these', 'this', 'those', 'to', 'was',
        'were', 'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why',
        'will', 'would'
      )
    GROUP BY alias
    ORDER BY
      cardinality(regexp_split_to_array(alias, '[[:space:]]+')) DESC,
      char_length(alias) DESC,
      alias
    LIMIT 64
  )
  SELECT COALESCE(
    array_agg(alias ORDER BY word_count DESC, alias_length DESC, alias),
    ARRAY[]::text[]
  )
  FROM bounded
$$;
--> statement-breakpoint


ALTER TABLE memory_chunks
  ADD COLUMN entity_aliases text[]
  GENERATED ALWAYS AS (lore.extract_entity_aliases(content)) STORED;
--> statement-breakpoint


CREATE INDEX memory_chunks_entity_aliases_idx
  ON memory_chunks USING gin (entity_aliases);
--> statement-breakpoint


COMMENT ON FUNCTION lore.extract_entity_aliases(text) IS
  'Deterministic exact alias index terms; never an inferred Memory or authorization signal.';
--> statement-breakpoint


REVOKE ALL ON FUNCTION lore.extract_entity_aliases(text) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.extract_entity_aliases(text) TO lore_app;
--> statement-breakpoint


DO $$
BEGIN
  UPDATE lore_system_state
  SET schema_revision = 6, updated_at = now()
  WHERE singleton AND schema_revision = 5;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected Lore schema revision 5 before migration 0006';
  END IF;
END
$$;
--> statement-breakpoint



-- Lore legacy migration 0007_agent_lifecycle.sql
CREATE INDEX memories_created_by_agent_idx
  ON memories (created_by_agent_id)
  WHERE created_by_agent_id IS NOT NULL;
--> statement-breakpoint


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
--> statement-breakpoint


COMMENT ON FUNCTION lore.protect_memory_identity() IS
  'Keeps Memory identity and provenance immutable while allowing an Agent foreign-key deletion to clear its provenance reference and advance the strong ETag version.';
--> statement-breakpoint


REVOKE ALL ON FUNCTION lore.protect_memory_identity() FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.protect_memory_identity() TO lore_app;
--> statement-breakpoint


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
--> statement-breakpoint



-- Lore legacy migration 0008_memory_proposals.sql
CREATE TYPE memory_proposal_kind AS ENUM ('create', 'update');
--> statement-breakpoint

CREATE TYPE memory_proposal_status AS ENUM ('pending', 'accepted', 'rejected');
--> statement-breakpoint


CREATE TABLE memory_proposals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposed_by_actor_kind text NOT NULL CHECK (proposed_by_actor_kind IN ('human', 'agent')),
  proposed_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  kind memory_proposal_kind NOT NULL,
  target_memory_id uuid,
  base_memory_version integer,
  proposed_content text NOT NULL CHECK (btrim(proposed_content) <> ''),
  proposed_scope memory_scope NOT NULL,
  proposed_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(proposed_metadata) = 'object'),
  changes_content boolean NOT NULL,
  changes_scope boolean NOT NULL,
  changes_metadata boolean NOT NULL,
  status memory_proposal_status NOT NULL DEFAULT 'pending',
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_memory_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  UNIQUE (workspace_id, id),
  CHECK (
    proposed_by_actor_kind = 'agent'
    OR proposed_by_agent_id IS NULL
  ),
  CHECK (
    (kind = 'create'
      AND target_memory_id IS NULL
      AND base_memory_version IS NULL
      AND changes_content
      AND changes_scope
      AND changes_metadata)
    OR
    (kind = 'update'
      AND target_memory_id IS NOT NULL
      AND base_memory_version > 0
      AND (changes_content OR changes_scope OR changes_metadata))
  ),
  CHECK (
    (status = 'pending'
      AND reviewed_by_user_id IS NULL
      AND accepted_memory_id IS NULL
      AND reviewed_at IS NULL
      AND expires_at = created_at + interval '30 days')
    OR
    (status = 'accepted'
      AND reviewed_by_user_id IS NOT NULL
      AND accepted_memory_id IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND expires_at = reviewed_at + interval '30 days')
    OR
    (status = 'rejected'
      AND reviewed_by_user_id IS NOT NULL
      AND accepted_memory_id IS NULL
      AND reviewed_at IS NOT NULL
      AND expires_at = reviewed_at + interval '30 days')
  )
);
--> statement-breakpoint


CREATE TABLE memory_proposal_evidence (
  workspace_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (proposal_id, memory_id),
  UNIQUE (proposal_id, ordinal),
  FOREIGN KEY (workspace_id, proposal_id)
    REFERENCES memory_proposals(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, memory_id)
    REFERENCES memories(workspace_id, id)
    ON DELETE CASCADE
);
--> statement-breakpoint


CREATE INDEX memory_proposals_owner_status_idx
  ON memory_proposals (workspace_id, owner_user_id, status, created_at DESC, id);
--> statement-breakpoint

CREATE INDEX memory_proposal_evidence_memory_idx
  ON memory_proposal_evidence (workspace_id, memory_id, proposal_id);
--> statement-breakpoint

CREATE INDEX memory_proposals_expiry_idx ON memory_proposals (expires_at);
--> statement-breakpoint


CREATE FUNCTION lore.can_read_memory_proposal(
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
    AND lore.current_agent_id() IS NULL
    AND lore.is_active_member(target_workspace_id)
$$;
--> statement-breakpoint


CREATE FUNCTION lore.can_append_memory_proposal_evidence(
  target_workspace_id uuid,
  target_proposal_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT target_workspace_id = lore.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM public.memory_proposals proposal
      WHERE proposal.id = target_proposal_id
        AND proposal.workspace_id = target_workspace_id
        AND proposal.owner_user_id = lore.current_user_id()
        AND proposal.status = 'pending'
        AND proposal.expires_at > now()
        AND proposal.proposed_by_agent_id IS NOT DISTINCT FROM lore.current_agent_id()
        AND proposal.proposed_by_actor_kind = CASE
          WHEN lore.current_agent_id() IS NULL THEN 'human'
          ELSE 'agent'
        END
        AND lore.can_write_memory(proposal.workspace_id, proposal.owner_user_id)
    )
$$;
--> statement-breakpoint


CREATE FUNCTION lore.can_review_memory_proposal(
  target_workspace_id uuid,
  target_owner_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT lore.current_agent_id() IS NULL
    AND target_workspace_id = lore.current_workspace_id()
    AND target_owner_user_id = lore.current_user_id()
    AND lore.is_active_member(target_workspace_id)
$$;
--> statement-breakpoint


CREATE FUNCTION lore.protect_memory_proposal_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.proposed_by_agent_id IS DISTINCT FROM OLD.proposed_by_agent_id THEN
    IF NEW.proposed_by_agent_id IS NULL
      AND OLD.proposed_by_agent_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.agents WHERE id = OLD.proposed_by_agent_id
      )
      AND NEW.id IS NOT DISTINCT FROM OLD.id
      AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
      AND NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id
      AND NEW.proposed_by_actor_kind IS NOT DISTINCT FROM OLD.proposed_by_actor_kind
      AND NEW.kind IS NOT DISTINCT FROM OLD.kind
      AND NEW.target_memory_id IS NOT DISTINCT FROM OLD.target_memory_id
      AND NEW.base_memory_version IS NOT DISTINCT FROM OLD.base_memory_version
      AND NEW.proposed_content IS NOT DISTINCT FROM OLD.proposed_content
      AND NEW.proposed_scope IS NOT DISTINCT FROM OLD.proposed_scope
      AND NEW.proposed_metadata IS NOT DISTINCT FROM OLD.proposed_metadata
      AND NEW.changes_content IS NOT DISTINCT FROM OLD.changes_content
      AND NEW.changes_scope IS NOT DISTINCT FROM OLD.changes_scope
      AND NEW.changes_metadata IS NOT DISTINCT FROM OLD.changes_metadata
      AND NEW.status IS NOT DISTINCT FROM OLD.status
      AND NEW.reviewed_by_user_id IS NOT DISTINCT FROM OLD.reviewed_by_user_id
      AND NEW.accepted_memory_id IS NOT DISTINCT FROM OLD.accepted_memory_id
      AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
      AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
      AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Memory Proposal provenance is immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.proposed_by_actor_kind IS DISTINCT FROM OLD.proposed_by_actor_kind
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.target_memory_id IS DISTINCT FROM OLD.target_memory_id
    OR NEW.base_memory_version IS DISTINCT FROM OLD.base_memory_version
    OR NEW.proposed_content IS DISTINCT FROM OLD.proposed_content
    OR NEW.proposed_scope IS DISTINCT FROM OLD.proposed_scope
    OR NEW.proposed_metadata IS DISTINCT FROM OLD.proposed_metadata
    OR NEW.changes_content IS DISTINCT FROM OLD.changes_content
    OR NEW.changes_scope IS DISTINCT FROM OLD.changes_scope
    OR NEW.changes_metadata IS DISTINCT FROM OLD.changes_metadata
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Memory Proposal content and identity are immutable'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status <> 'pending'
    OR NEW.status NOT IN ('accepted', 'rejected')
    OR NEW.reviewed_by_user_id IS DISTINCT FROM lore.current_user_id()
    OR NEW.reviewed_at IS NULL
    OR NEW.expires_at IS DISTINCT FROM NEW.reviewed_at + interval '30 days'
  THEN
    RAISE EXCEPTION 'Invalid Memory Proposal review transition'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'accepted' AND OLD.kind = 'update' THEN
    IF NEW.accepted_memory_id IS DISTINCT FROM OLD.target_memory_id
      OR NOT EXISTS (
        SELECT 1
        FROM public.memories memory
        WHERE memory.id = NEW.accepted_memory_id
          AND memory.workspace_id = OLD.workspace_id
          AND memory.owner_user_id = OLD.owner_user_id
          AND memory.version = OLD.base_memory_version + 1
          AND memory.content = OLD.proposed_content
          AND memory.scope = OLD.proposed_scope
          AND memory.metadata = OLD.proposed_metadata
      )
    THEN
      RAISE EXCEPTION 'Accepted update receipt must match the canonical Memory'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.status = 'accepted' AND OLD.kind = 'create' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.memories memory
      WHERE memory.id = NEW.accepted_memory_id
        AND memory.workspace_id = OLD.workspace_id
        AND memory.owner_user_id = OLD.owner_user_id
        AND memory.created_by_agent_id IS NULL
        AND memory.version = 1
        AND memory.content = OLD.proposed_content
        AND memory.scope = OLD.proposed_scope
        AND memory.metadata = OLD.proposed_metadata
        AND memory.created_at >= OLD.created_at
    )
    THEN
      RAISE EXCEPTION 'Accepted create receipt must match the canonical Memory'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.validate_memory_proposal_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
  FROM public.memberships membership
  WHERE membership.workspace_id = NEW.workspace_id
    AND membership.user_id = NEW.owner_user_id
  FOR UPDATE;

  IF (
    SELECT count(*)
    FROM public.memory_proposals proposal
    WHERE proposal.workspace_id = NEW.workspace_id
      AND proposal.owner_user_id = NEW.owner_user_id
      AND proposal.status = 'pending'
      AND proposal.expires_at > now()
  ) >= 100
  THEN
    RAISE EXCEPTION 'Memory Proposal pending limit reached'
      USING ERRCODE = '54000';
  END IF;

  IF NEW.kind = 'update'
    AND NOT EXISTS (
      SELECT 1
      FROM public.memories memory
      WHERE memory.id = NEW.target_memory_id
        AND memory.workspace_id = NEW.workspace_id
        AND memory.owner_user_id = NEW.owner_user_id
    )
  THEN
    RAISE EXCEPTION 'Memory Proposal target must be an owned Memory in this Workspace'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint


CREATE TRIGGER memory_proposals_validate_target
BEFORE INSERT ON memory_proposals
FOR EACH ROW
EXECUTE FUNCTION lore.validate_memory_proposal_target();
--> statement-breakpoint


CREATE TRIGGER memory_proposals_protect_review
BEFORE UPDATE ON memory_proposals
FOR EACH ROW
EXECUTE FUNCTION lore.protect_memory_proposal_review();
--> statement-breakpoint


CREATE FUNCTION lore.submit_memory_proposal(
  target_workspace_id uuid,
  target_owner_user_id uuid,
  target_actor_kind text,
  target_agent_id uuid,
  target_kind memory_proposal_kind,
  target_memory_id uuid,
  target_base_memory_version integer,
  target_content text,
  target_scope memory_scope,
  target_metadata jsonb,
  target_changes_content boolean,
  target_changes_scope boolean,
  target_changes_metadata boolean
)
RETURNS SETOF memory_proposals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT lore.can_write_memory(target_workspace_id, target_owner_user_id)
    OR target_actor_kind IS DISTINCT FROM (CASE
      WHEN lore.current_agent_id() IS NULL THEN 'human'
      ELSE 'agent'
    END)
    OR target_agent_id IS DISTINCT FROM lore.current_agent_id()
  THEN
    RAISE EXCEPTION 'Actor cannot submit this Memory Proposal'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  INSERT INTO public.memory_proposals (
    id, workspace_id, owner_user_id, proposed_by_actor_kind,
    proposed_by_agent_id, kind, target_memory_id, base_memory_version,
    proposed_content, proposed_scope, proposed_metadata,
    changes_content, changes_scope, changes_metadata
  ) VALUES (
    gen_random_uuid(), target_workspace_id, target_owner_user_id, target_actor_kind,
    target_agent_id, target_kind, target_memory_id, target_base_memory_version,
    target_content, target_scope, target_metadata,
    target_changes_content, target_changes_scope, target_changes_metadata
  )
  RETURNING public.memory_proposals.*;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.scrub_deleted_memory_proposal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id
    AND replay.response_body #>> '{proposal,id}' = OLD.id::text;
  RETURN OLD;
END
$$;
--> statement-breakpoint


CREATE TRIGGER memory_proposals_scrub_idempotency
AFTER DELETE ON memory_proposals
FOR EACH ROW
EXECUTE FUNCTION lore.scrub_deleted_memory_proposal();
--> statement-breakpoint


CREATE FUNCTION lore.remove_proposals_for_deleted_memory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.memory_proposals proposal
  WHERE proposal.workspace_id = OLD.workspace_id
    AND (
      proposal.target_memory_id = OLD.id
      OR proposal.accepted_memory_id = OLD.id
    );

  DELETE FROM public.request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id
    AND (
      replay.response_body #>> '{proposal,targetMemoryId}' = OLD.id::text
      OR replay.response_body #>> '{proposal,acceptedMemoryId}' = OLD.id::text
    );
  RETURN OLD;
END
$$;
--> statement-breakpoint


CREATE TRIGGER memories_remove_proposals_before_delete
BEFORE DELETE ON memories
FOR EACH ROW
EXECUTE FUNCTION lore.remove_proposals_for_deleted_memory();
--> statement-breakpoint


ALTER TABLE memory_proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE memory_proposal_evidence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint


CREATE POLICY memory_proposals_select ON memory_proposals
  FOR SELECT
  USING (
    lore.can_read_memory_proposal(workspace_id, owner_user_id)
    AND expires_at > now()
  );
--> statement-breakpoint


CREATE POLICY memory_proposals_insert ON memory_proposals
  FOR INSERT
  WITH CHECK (
    lore.can_write_memory(workspace_id, owner_user_id)
    AND proposed_by_actor_kind = CASE
      WHEN lore.current_agent_id() IS NULL THEN 'human'
      ELSE 'agent'
    END
    AND proposed_by_agent_id IS NOT DISTINCT FROM lore.current_agent_id()
    AND status = 'pending'
  );
--> statement-breakpoint


CREATE POLICY memory_proposals_update ON memory_proposals
  FOR UPDATE
  USING (lore.can_review_memory_proposal(workspace_id, owner_user_id))
  WITH CHECK (lore.can_review_memory_proposal(workspace_id, owner_user_id));
--> statement-breakpoint


CREATE POLICY memory_proposal_evidence_select ON memory_proposal_evidence
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM memory_proposals proposal
      WHERE proposal.id = memory_proposal_evidence.proposal_id
        AND proposal.workspace_id = memory_proposal_evidence.workspace_id
    )
    AND EXISTS (
      SELECT 1
      FROM memories memory
      WHERE memory.id = memory_proposal_evidence.memory_id
        AND memory.workspace_id = memory_proposal_evidence.workspace_id
        AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)
    )
  );
--> statement-breakpoint


CREATE POLICY memory_proposal_evidence_insert ON memory_proposal_evidence
  FOR INSERT
  WITH CHECK (
    lore.can_append_memory_proposal_evidence(
      memory_proposal_evidence.workspace_id,
      memory_proposal_evidence.proposal_id
    )
    AND EXISTS (
      SELECT 1
      FROM memories memory
      WHERE memory.id = memory_proposal_evidence.memory_id
        AND memory.workspace_id = memory_proposal_evidence.workspace_id
        AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)
    )
  );
--> statement-breakpoint


REVOKE ALL ON FUNCTION lore.can_read_memory_proposal(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.can_append_memory_proposal_evidence(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.can_review_memory_proposal(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.submit_memory_proposal(
  uuid, uuid, text, uuid, memory_proposal_kind, uuid, integer,
  text, memory_scope, jsonb, boolean, boolean, boolean
) FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.protect_memory_proposal_review() FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.validate_memory_proposal_target() FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.scrub_deleted_memory_proposal() FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.remove_proposals_for_deleted_memory() FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.can_read_memory_proposal(uuid, uuid) TO lore_app;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.can_append_memory_proposal_evidence(uuid, uuid) TO lore_app;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.can_review_memory_proposal(uuid, uuid) TO lore_app;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.submit_memory_proposal(
  uuid, uuid, text, uuid, memory_proposal_kind, uuid, integer,
  text, memory_scope, jsonb, boolean, boolean, boolean
) TO lore_app;
--> statement-breakpoint

GRANT SELECT, UPDATE ON memory_proposals TO lore_app;
--> statement-breakpoint

GRANT SELECT, INSERT ON memory_proposal_evidence TO lore_app;
--> statement-breakpoint


CREATE OR REPLACE FUNCTION lore.portable_core_capabilities()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'apiVersion', state.api_version,
    'schemaRevision', state.schema_revision,
    'deploymentId', state.deployment_id,
    'features', jsonb_build_object(
      'idempotency', true,
      'optimisticConcurrency', true,
      'transactionalOutbox', true,
      'workspacePortability', true,
      'embeddingGenerations', true,
      'cursorPagination', true,
      'memoryProposals', true
    ),
    'limits', jsonb_build_object(
      'workspaceArchiveMemories', 10000,
      'workspaceArchiveLinks', 50000,
      'memoryProposalEvidence', 50,
      'memoryProposalList', 100,
      'memoryProposalPending', 100,
      'memoryProposalRetentionSeconds', 2592000
    ),
    'activeEmbeddingGeneration', (
      SELECT jsonb_build_object(
        'provider', generation.embedding_provider,
        'model', generation.embedding_model,
        'dimensions', generation.embedding_dimensions,
        'revision', generation.embedding_revision
      )
      FROM embedding_generations generation
      WHERE generation.status = 'active'
    )
  )
  FROM lore_system_state state
  WHERE state.singleton
$$;
--> statement-breakpoint


CREATE OR REPLACE FUNCTION lore.purge_expired_portable_core_records()
RETURNS TABLE (idempotency_records bigint, memory_event_records bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  idempotency_count bigint;
  event_count bigint;
BEGIN
  DELETE FROM public.memory_proposals WHERE expires_at <= now();
  DELETE FROM public.request_idempotency_records WHERE expires_at <= now();
  GET DIAGNOSTICS idempotency_count = ROW_COUNT;
  DELETE FROM public.memory_events WHERE expires_at <= now();
  GET DIAGNOSTICS event_count = ROW_COUNT;
  RETURN QUERY SELECT idempotency_count, event_count;
END
$$;
--> statement-breakpoint


COMMENT ON TABLE memory_proposals IS
  'Owner-private, non-canonical review state. Content expires after 30 days and is removed with its target or accepted Memory.';
--> statement-breakpoint

COMMENT ON COLUMN memory_proposals.expires_at IS
  'Hard content-retention boundary: 30 days after submission or the latest review.';
--> statement-breakpoint


DO $$
BEGIN
  UPDATE lore_system_state
  SET schema_revision = 8, updated_at = now()
  WHERE singleton AND schema_revision = 7;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected Lore schema revision 7 before migration 0008';
  END IF;
END
$$;
--> statement-breakpoint



-- Lore legacy migration 0009_observation_evidence.sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM lore_system_state
    WHERE singleton AND schema_revision = 8
  ) THEN
    RAISE EXCEPTION 'Expected Lore schema revision 8 before migration 0009';
  END IF;
END
$$;
--> statement-breakpoint


CREATE TYPE episode_kind AS ENUM ('conversation', 'workflow', 'document', 'event');
--> statement-breakpoint

CREATE TYPE observation_kind AS ENUM (
  'message',
  'tool_call',
  'tool_result',
  'document_fragment',
  'event'
);
--> statement-breakpoint


CREATE TABLE episodes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recorded_by_actor_kind text NOT NULL CHECK (recorded_by_actor_kind IN ('human', 'agent')),
  recorded_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  kind episode_kind NOT NULL,
  scope memory_scope NOT NULL DEFAULT 'private',
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CHECK (ended_at >= started_at),
  CHECK (
    recorded_by_actor_kind = 'agent'
    OR recorded_by_agent_id IS NULL
  )
);
--> statement-breakpoint


CREATE TABLE observations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind observation_kind NOT NULL,
  observed_at timestamptz NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  content text NOT NULL CHECK (
    btrim(content) <> ''
    AND length(content) <= 100000
  ),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (episode_id, ordinal),
  FOREIGN KEY (workspace_id, episode_id)
    REFERENCES episodes(workspace_id, id)
    ON DELETE CASCADE
);
--> statement-breakpoint


CREATE TABLE memory_proposal_observation_evidence (
  workspace_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  observation_id uuid REFERENCES observations(id) ON DELETE SET NULL,
  observation_reference_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (proposal_id, observation_reference_id),
  UNIQUE (proposal_id, ordinal),
  FOREIGN KEY (workspace_id, proposal_id)
    REFERENCES memory_proposals(workspace_id, id)
    ON DELETE CASCADE,
  CHECK (observation_id IS NULL OR observation_id = observation_reference_id)
);
--> statement-breakpoint


CREATE INDEX episodes_owner_created_idx
  ON episodes (workspace_id, owner_user_id, created_at DESC, id);
--> statement-breakpoint

CREATE INDEX episodes_workspace_created_idx
  ON episodes (workspace_id, created_at DESC, id);
--> statement-breakpoint

CREATE INDEX observations_episode_idx
  ON observations (workspace_id, episode_id, ordinal);
--> statement-breakpoint

CREATE INDEX memory_proposal_observation_evidence_observation_idx
  ON memory_proposal_observation_evidence (workspace_id, observation_id, proposal_id);
--> statement-breakpoint


CREATE FUNCTION lore.record_episode(
  target_workspace_id uuid,
  target_owner_user_id uuid,
  target_actor_kind text,
  target_agent_id uuid,
  target_kind episode_kind,
  target_scope memory_scope,
  target_started_at timestamptz,
  target_ended_at timestamptz,
  target_observations json
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  episode_identifier uuid := gen_random_uuid();
  observation_record record;
  observation_identifier uuid;
  observation_metadata json;
  observation_timestamp timestamptz;
  total_characters bigint;
  total_metadata_characters bigint;
BEGIN
  IF NOT lore.can_write_memory(target_workspace_id, target_owner_user_id)
    OR target_actor_kind IS DISTINCT FROM (CASE
      WHEN lore.current_agent_id() IS NULL THEN 'human'
      ELSE 'agent'
    END)
    OR target_agent_id IS DISTINCT FROM lore.current_agent_id()
  THEN
    RAISE EXCEPTION 'Actor cannot record this Episode'
      USING ERRCODE = '42501';
  END IF;

  IF target_ended_at < target_started_at
    OR json_typeof(target_observations) IS DISTINCT FROM 'array'
    OR json_array_length(target_observations) NOT BETWEEN 1 AND 100
  THEN
    RAISE EXCEPTION 'Episode observations are invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    sum(length(observation.value->>'content')),
    COALESCE(sum(length((observation.value->'metadata')::text)), 0)
  INTO total_characters, total_metadata_characters
  FROM json_array_elements(target_observations) observation(value);
  IF total_characters IS NULL OR total_characters > 1000000 THEN
    RAISE EXCEPTION 'Episode observation content exceeds its bound'
      USING ERRCODE = '22023';
  END IF;
  IF total_metadata_characters > 1000000 THEN
    RAISE EXCEPTION 'Episode observation metadata exceeds its bound'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.episodes (
    id, workspace_id, owner_user_id, recorded_by_actor_kind,
    recorded_by_agent_id, kind, scope, started_at, ended_at
  ) VALUES (
    episode_identifier, target_workspace_id, target_owner_user_id, target_actor_kind,
    target_agent_id, target_kind, target_scope, target_started_at, target_ended_at
  );

  FOR observation_record IN
    SELECT value, ordinal - 1 AS ordinal
    FROM json_array_elements(target_observations) WITH ORDINALITY item(value, ordinal)
    ORDER BY ordinal
  LOOP
    observation_identifier := gen_random_uuid();
    observation_metadata := observation_record.value->'metadata';
    observation_timestamp := (observation_record.value->>'observedAt')::timestamptz;
    IF observation_timestamp < target_started_at
      OR observation_timestamp > target_ended_at
      OR json_typeof(observation_metadata) IS DISTINCT FROM 'object'
      OR length(observation_metadata::text) > 100000
    THEN
      RAISE EXCEPTION 'Observation is outside its Episode envelope'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.observations (
      id, workspace_id, episode_id, ordinal, kind, observed_at,
      payload_sha256, content, metadata
    ) VALUES (
      observation_identifier,
      target_workspace_id,
      episode_identifier,
      observation_record.ordinal,
      (observation_record.value->>'kind')::observation_kind,
      observation_timestamp,
      encode(
        sha256(
          convert_to(
            jsonb_build_object(
              'kind', observation_record.value->>'kind',
              'content', observation_record.value->>'content',
              'metadata', observation_metadata::jsonb,
              'observedAt', to_char(
                observation_timestamp AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              )
            )::text,
            'UTF8'
          )
        ),
        'hex'
      ),
      observation_record.value->>'content',
      observation_metadata::jsonb
    );
  END LOOP;

  RETURN episode_identifier;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.scrub_deleted_episode_replay()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id
    AND replay.response_body #>> '{episode,id}' = OLD.id::text;
  RETURN OLD;
END
$$;
--> statement-breakpoint


CREATE FUNCTION lore.lock_reviewable_proposal_observations(
  target_workspace_id uuid,
  target_proposal_id uuid
)
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT observation.id
  FROM public.memory_proposal_observation_evidence evidence
  JOIN public.memory_proposals proposal
    ON proposal.workspace_id = evidence.workspace_id
   AND proposal.id = evidence.proposal_id
  JOIN public.observations observation
    ON observation.id = evidence.observation_id
  JOIN public.episodes episode
    ON episode.workspace_id = observation.workspace_id
   AND episode.id = observation.episode_id
  WHERE evidence.workspace_id = target_workspace_id
    AND evidence.proposal_id = target_proposal_id
    AND target_workspace_id = lore.current_workspace_id()
    AND lore.can_review_memory_proposal(proposal.workspace_id, proposal.owner_user_id)
    AND lore.can_read_memory(episode.workspace_id, episode.owner_user_id, episode.scope)
  FOR KEY SHARE OF observation
$$;
--> statement-breakpoint


CREATE TRIGGER episodes_scrub_idempotency
AFTER DELETE ON episodes
FOR EACH ROW
EXECUTE FUNCTION lore.scrub_deleted_episode_replay();
--> statement-breakpoint


ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE memory_proposal_observation_evidence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint


CREATE POLICY episodes_select ON episodes
  FOR SELECT
  USING (lore.can_read_memory(workspace_id, owner_user_id, scope));
--> statement-breakpoint


CREATE POLICY episodes_delete ON episodes
  FOR DELETE
  USING (lore.can_write_memory(workspace_id, owner_user_id));
--> statement-breakpoint


CREATE POLICY observations_select ON observations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM episodes episode
      WHERE episode.id = observations.episode_id
        AND episode.workspace_id = observations.workspace_id
    )
  );
--> statement-breakpoint


CREATE POLICY memory_proposal_observation_evidence_select
  ON memory_proposal_observation_evidence
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM memory_proposals proposal
      WHERE proposal.id = memory_proposal_observation_evidence.proposal_id
        AND proposal.workspace_id = memory_proposal_observation_evidence.workspace_id
    )
  );
--> statement-breakpoint


CREATE POLICY memory_proposal_observation_evidence_insert
  ON memory_proposal_observation_evidence
  FOR INSERT
  WITH CHECK (
    lore.can_append_memory_proposal_evidence(
      memory_proposal_observation_evidence.workspace_id,
      memory_proposal_observation_evidence.proposal_id
    )
    AND memory_proposal_observation_evidence.observation_id =
      memory_proposal_observation_evidence.observation_reference_id
    AND EXISTS (
      SELECT 1
      FROM observations observation
      WHERE observation.id = memory_proposal_observation_evidence.observation_id
        AND observation.workspace_id = memory_proposal_observation_evidence.workspace_id
    )
  );
--> statement-breakpoint


REVOKE ALL ON FUNCTION lore.record_episode(
  uuid, uuid, text, uuid, episode_kind, memory_scope,
  timestamptz, timestamptz, json
) FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.scrub_deleted_episode_replay() FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lore.lock_reviewable_proposal_observations(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.record_episode(
  uuid, uuid, text, uuid, episode_kind, memory_scope,
  timestamptz, timestamptz, json
) TO lore_app;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION lore.lock_reviewable_proposal_observations(uuid, uuid) TO lore_app;
--> statement-breakpoint

GRANT SELECT, DELETE ON episodes TO lore_app;
--> statement-breakpoint

GRANT SELECT ON observations TO lore_app;
--> statement-breakpoint

GRANT SELECT, INSERT ON memory_proposal_observation_evidence TO lore_app;
--> statement-breakpoint


CREATE OR REPLACE FUNCTION lore.portable_core_capabilities()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'apiVersion', state.api_version,
    'schemaRevision', state.schema_revision,
    'deploymentId', state.deployment_id,
    'features', jsonb_build_object(
      'idempotency', true,
      'optimisticConcurrency', true,
      'transactionalOutbox', true,
      'workspacePortability', true,
      'embeddingGenerations', true,
      'cursorPagination', true,
      'memoryProposals', true,
      'observationEvidence', true
    ),
    'limits', jsonb_build_object(
      'workspaceArchiveMemories', 10000,
      'workspaceArchiveLinks', 50000,
      'memoryProposalEvidence', 50,
      'memoryProposalList', 100,
      'memoryProposalPending', 100,
      'memoryProposalRetentionSeconds', 2592000,
      'episodeObservations', 100,
      'episodeContentCharacters', 1000000,
      'episodeMetadataCharacters', 1000000,
      'observationContentCharacters', 100000,
      'observationBatchRead', 50
    ),
    'activeEmbeddingGeneration', (
      SELECT jsonb_build_object(
        'provider', generation.embedding_provider,
        'model', generation.embedding_model,
        'dimensions', generation.embedding_dimensions,
        'revision', generation.embedding_revision
      )
      FROM embedding_generations generation
      WHERE generation.status = 'active'
    )
  )
  FROM lore_system_state state
  WHERE state.singleton
$$;
--> statement-breakpoint


CREATE OR REPLACE FUNCTION lore.purge_expired_portable_core_records()
RETURNS TABLE (idempotency_records bigint, memory_event_records bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  idempotency_count bigint;
  event_count bigint;
BEGIN
  DELETE FROM public.memory_proposals WHERE expires_at <= now();
  DELETE FROM public.request_idempotency_records WHERE expires_at <= now();
  GET DIAGNOSTICS idempotency_count = ROW_COUNT;
  DELETE FROM public.memory_events WHERE expires_at <= now();
  GET DIAGNOSTICS event_count = ROW_COUNT;
  RETURN QUERY SELECT idempotency_count, event_count;
END
$$;
--> statement-breakpoint


COMMENT ON TABLE episodes IS
  'Immutable evidence envelopes. Episodes group ordered Observations but are not canonical Memory.';
--> statement-breakpoint

COMMENT ON TABLE observations IS
  'Immutable, durable evidence records. Content remains until its Episode is explicitly forgotten.';
--> statement-breakpoint

COMMENT ON TABLE memory_proposal_observation_evidence IS
  'Owner-private Proposal evidence references. Explicit forget nulls the live pointer but retains the content-free cited id until Proposal expiry.';
--> statement-breakpoint


DO $$
BEGIN
  UPDATE lore_system_state
  SET schema_revision = 9, updated_at = now()
  WHERE singleton AND schema_revision = 8;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected Lore schema revision 8 before migration 0009';
  END IF;
END
$$;
