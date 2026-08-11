-- migrate:up

CREATE EXTENSION IF NOT EXISTS vector;

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
CREATE TYPE agent_status AS ENUM ('active', 'disabled');
CREATE TYPE agent_grant_permission AS ENUM ('read', 'write');
CREATE TYPE agent_grant_status AS ENUM ('active', 'revoked');
CREATE TYPE evaluation_run_status AS ENUM ('running', 'completed', 'failed');

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

CREATE INDEX memories_workspace_updated_idx ON memories (workspace_id, updated_at DESC, id);
CREATE INDEX memories_owner_updated_idx
  ON memories (workspace_id, owner_user_id, updated_at DESC);
CREATE INDEX memory_chunks_workspace_memory_idx
  ON memory_chunks (workspace_id, memory_id);
CREATE INDEX memory_chunks_search_idx ON memory_chunks USING gin (search_vector);
CREATE INDEX memory_chunks_embedding_cosine_idx
  ON memory_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX memory_links_workspace_source_idx
  ON memory_links (workspace_id, source_memory_id);
CREATE INDEX memory_links_workspace_target_idx
  ON memory_links (workspace_id, target_memory_id);
CREATE INDEX evaluation_suites_workspace_idx
  ON evaluation_suites (workspace_id, created_by_user_id, updated_at DESC, id);
CREATE INDEX evaluation_cases_suite_idx
  ON evaluation_cases (workspace_id, created_by_user_id, suite_id, ordinal, id);
CREATE INDEX evaluation_runs_suite_idx
  ON evaluation_runs (workspace_id, created_by_user_id, suite_id, started_at DESC, id);

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

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workspace_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_suites ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_results ENABLE ROW LEVEL SECURITY;

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

CREATE POLICY memberships_insert ON memberships
  FOR INSERT
  WITH CHECK (lore.can_manage_workspace(workspace_id));

CREATE POLICY memberships_update ON memberships
  FOR UPDATE
  USING (lore.can_manage_workspace(workspace_id))
  WITH CHECK (lore.can_manage_workspace(workspace_id));

CREATE POLICY memberships_delete ON memberships
  FOR DELETE
  USING (lore.can_manage_workspace(workspace_id));

CREATE POLICY agents_select ON agents
  FOR SELECT
  USING (
    owner_user_id = lore.current_user_id()
    AND lore.current_agent_id() IS NULL
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
    AND lore.current_agent_id() IS NULL
    AND lore.agent_owned_by_current_user(agent_id)
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

CREATE POLICY identities_select ON identities
  FOR SELECT
  USING (user_id = lore.current_user_id());

CREATE POLICY memories_select ON memories
  FOR SELECT
  USING (lore.can_read_memory(workspace_id, owner_user_id, scope));

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

CREATE POLICY memories_delete ON memories
  FOR DELETE
  USING (lore.can_write_memory(workspace_id, owner_user_id));

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

CREATE POLICY evaluation_suites_all ON evaluation_suites
  FOR ALL
  USING (lore.can_manage_evaluations(workspace_id, created_by_user_id))
  WITH CHECK (lore.can_manage_evaluations(workspace_id, created_by_user_id));

CREATE POLICY evaluation_cases_all ON evaluation_cases
  FOR ALL
  USING (lore.can_manage_evaluations(workspace_id, created_by_user_id))
  WITH CHECK (lore.can_manage_evaluations(workspace_id, created_by_user_id));

CREATE POLICY evaluation_runs_all ON evaluation_runs
  FOR ALL
  USING (lore.can_manage_evaluations(workspace_id, created_by_user_id))
  WITH CHECK (lore.can_manage_evaluations(workspace_id, created_by_user_id));

CREATE POLICY evaluation_results_all ON evaluation_results
  FOR ALL
  USING (lore.can_manage_evaluations(workspace_id, created_by_user_id))
  WITH CHECK (lore.can_manage_evaluations(workspace_id, created_by_user_id));

REVOKE ALL ON SCHEMA lore FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lore FROM PUBLIC;

GRANT USAGE ON SCHEMA lore TO lore_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lore TO lore_app;
GRANT SELECT ON users, workspaces, memberships TO lore_app;
GRANT INSERT, UPDATE, DELETE ON memberships TO lore_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON memories, agents, agent_workspace_grants, memory_chunks, memory_links,
     evaluation_suites, evaluation_cases, evaluation_runs, evaluation_results
  TO lore_app;
GRANT INSERT, UPDATE, DELETE ON agent_credentials TO lore_app;
GRANT SELECT (id, agent_id, secret_prefix, created_at, last_used_at, revoked_at)
  ON agent_credentials TO lore_app;
GRANT SELECT (id, user_id, provider, subject, email, created_at, updated_at)
  ON identities TO lore_app;

-- migrate:down
