DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lore_app') THEN
    CREATE ROLE lore_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

SET check_function_bodies = false;

CREATE SCHEMA lore;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';

CREATE TYPE public.agent_grant_permission AS ENUM (
    'read',
    'write'
);

CREATE TYPE public.agent_grant_status AS ENUM (
    'active',
    'revoked'
);

CREATE TYPE public.agent_status AS ENUM (
    'active',
    'disabled'
);

CREATE TYPE public.evaluation_run_status AS ENUM (
    'running',
    'completed',
    'failed'
);

CREATE TYPE public.membership_role AS ENUM (
    'owner',
    'admin',
    'member'
);

CREATE TYPE public.membership_status AS ENUM (
    'active',
    'suspended'
);

CREATE TYPE public.memory_scope AS ENUM (
    'shared',
    'private'
);

CREATE FUNCTION lore.agent_has_access(target_workspace_id uuid, required_permission public.agent_grant_permission) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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

CREATE FUNCTION lore.agent_owned_by_current_user(target_agent_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM agents
    WHERE id = target_agent_id
      AND owner_user_id = lore.current_user_id()
  )
$$;

CREATE FUNCTION lore.authenticate_agent_credential(candidate_secret_hash text, target_workspace_id uuid) RETURNS TABLE(user_id uuid, agent_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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

CREATE FUNCTION lore.can_manage_evaluations(target_workspace_id uuid, target_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT target_workspace_id = lore.current_workspace_id()
    AND target_user_id = lore.current_user_id()
    AND lore.is_active_member(target_workspace_id)
    AND lore.current_agent_id() IS NULL
$$;

CREATE FUNCTION lore.can_manage_workspace(target_workspace_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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

CREATE FUNCTION lore.can_read_memory(target_workspace_id uuid, target_owner_user_id uuid, target_scope public.memory_scope) RETURNS boolean
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT target_workspace_id = lore.current_workspace_id()
    AND CASE
      WHEN lore.current_agent_id() IS NULL THEN lore.is_active_member(target_workspace_id)
      ELSE lore.agent_has_access(target_workspace_id, 'read')
    END
    AND (target_scope = 'shared' OR target_owner_user_id = lore.current_user_id())
$$;

CREATE FUNCTION lore.can_read_user(target_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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

CREATE FUNCTION lore.can_write_memory(target_workspace_id uuid, target_owner_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT target_workspace_id = lore.current_workspace_id()
    AND target_owner_user_id = lore.current_user_id()
    AND CASE
      WHEN lore.current_agent_id() IS NULL THEN lore.is_active_member(target_workspace_id)
      ELSE lore.agent_has_access(target_workspace_id, 'write')
    END
$$;

CREATE FUNCTION lore.create_workspace(new_workspace_id uuid, workspace_name text) RETURNS TABLE(id uuid, name text, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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

CREATE FUNCTION lore.current_agent_id() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT nullif(current_setting('lore.agent_id', true), '')::uuid
$$;

CREATE FUNCTION lore.current_user_id() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT nullif(current_setting('lore.user_id', true), '')::uuid
$$;

CREATE FUNCTION lore.current_workspace_id() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT nullif(current_setting('lore.workspace_id', true), '')::uuid
$$;

CREATE FUNCTION lore.is_active_member(target_workspace_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM memberships
    WHERE workspace_id = target_workspace_id
      AND user_id = lore.current_user_id()
      AND status = 'active'
  )
$$;

CREATE FUNCTION lore.list_workspaces() RETURNS TABLE(id uuid, name text, role public.membership_role, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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

CREATE FUNCTION lore.protect_memory_identity() RETURNS trigger
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

CREATE FUNCTION lore.register_identity(new_user_id uuid, new_identity_id uuid, identity_provider text, identity_subject text, user_display_name text, identity_email text) RETURNS TABLE(id uuid, display_name text, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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

CREATE FUNCTION lore.resolve_identity(identity_provider text, identity_subject text) RETURNS TABLE(id uuid, display_name text, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT app_user.id, app_user.display_name, app_user.created_at, app_user.updated_at
  FROM identities identity_row
  JOIN users app_user ON app_user.id = identity_row.user_id
  WHERE identity_row.provider = identity_provider
    AND identity_row.subject = identity_subject
$$;

CREATE TABLE public.agent_credentials (
    id uuid NOT NULL,
    agent_id uuid NOT NULL,
    secret_prefix text NOT NULL,
    secret_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT agent_credentials_secret_hash_check CHECK ((length(secret_hash) = 64)),
    CONSTRAINT agent_credentials_secret_prefix_check CHECK (((length(secret_prefix) >= 8) AND (length(secret_prefix) <= 32)))
);

CREATE TABLE public.agent_workspace_grants (
    workspace_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    permission public.agent_grant_permission DEFAULT 'read'::public.agent_grant_permission NOT NULL,
    status public.agent_grant_status DEFAULT 'active'::public.agent_grant_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.agents (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    name text NOT NULL,
    status public.agent_status DEFAULT 'active'::public.agent_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agents_name_check CHECK ((btrim(name) <> ''::text))
);

CREATE TABLE public.evaluation_cases (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    suite_id uuid NOT NULL,
    created_by_user_id uuid NOT NULL,
    ordinal integer NOT NULL,
    query text NOT NULL,
    expected_memory_ids uuid[] NOT NULL,
    forbidden_memory_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    result_limit integer DEFAULT 10 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT evaluation_cases_expected_memory_ids_check CHECK ((cardinality(expected_memory_ids) > 0)),
    CONSTRAINT evaluation_cases_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT evaluation_cases_query_check CHECK ((btrim(query) <> ''::text)),
    CONSTRAINT evaluation_cases_result_limit_check CHECK (((result_limit >= 1) AND (result_limit <= 100)))
);

CREATE TABLE public.evaluation_results (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    run_id uuid NOT NULL,
    case_id uuid NOT NULL,
    created_by_user_id uuid NOT NULL,
    retrieved_memory_ids uuid[] NOT NULL,
    metrics jsonb NOT NULL,
    latency_ms double precision NOT NULL,
    estimated_cost_usd numeric(16,8) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT evaluation_results_estimated_cost_usd_check CHECK ((estimated_cost_usd >= (0)::numeric)),
    CONSTRAINT evaluation_results_latency_ms_check CHECK ((latency_ms >= (0)::double precision)),
    CONSTRAINT evaluation_results_metrics_check CHECK ((jsonb_typeof(metrics) = 'object'::text))
);

CREATE TABLE public.evaluation_runs (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    suite_id uuid NOT NULL,
    created_by_user_id uuid NOT NULL,
    status public.evaluation_run_status DEFAULT 'running'::public.evaluation_run_status NOT NULL,
    metrics jsonb,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT evaluation_runs_check CHECK ((((status = 'running'::public.evaluation_run_status) AND (completed_at IS NULL)) OR ((status <> 'running'::public.evaluation_run_status) AND (completed_at IS NOT NULL))))
);

CREATE TABLE public.evaluation_suites (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    created_by_user_id uuid NOT NULL,
    name text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT evaluation_suites_name_check CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT evaluation_suites_version_check CHECK ((version > 0))
);

CREATE TABLE public.identities (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    subject text NOT NULL,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identities_provider_check CHECK ((btrim(provider) <> ''::text)),
    CONSTRAINT identities_subject_check CHECK ((btrim(subject) <> ''::text))
);

CREATE TABLE public.memberships (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.membership_role DEFAULT 'member'::public.membership_role NOT NULL,
    status public.membership_status DEFAULT 'active'::public.membership_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.memories (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    created_by_agent_id uuid,
    scope public.memory_scope DEFAULT 'shared'::public.memory_scope NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memories_content_check CHECK ((btrim(content) <> ''::text)),
    CONSTRAINT memories_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT memories_version_check CHECK ((version > 0))
);

CREATE TABLE public.memory_chunks (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    ordinal integer NOT NULL,
    content text NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding public.vector(1536),
    embedding_model text,
    embedded_at timestamp with time zone,
    CONSTRAINT memory_chunks_content_check CHECK ((btrim(content) <> ''::text)),
    CONSTRAINT memory_chunks_embedding_state_check CHECK ((((embedding IS NULL) AND (embedding_model IS NULL) AND (embedded_at IS NULL)) OR ((embedding IS NOT NULL) AND (embedding_model IS NOT NULL) AND (embedded_at IS NOT NULL)))),
    CONSTRAINT memory_chunks_ordinal_check CHECK ((ordinal >= 0))
);

CREATE TABLE public.users (
    id uuid NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_display_name_check CHECK ((btrim(display_name) <> ''::text))
);

CREATE TABLE public.workspaces (
    id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspaces_name_check CHECK ((btrim(name) <> ''::text))
);

ALTER TABLE ONLY public.agent_credentials
    ADD CONSTRAINT agent_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_credentials
    ADD CONSTRAINT agent_credentials_secret_hash_key UNIQUE (secret_hash);

ALTER TABLE ONLY public.agent_workspace_grants
    ADD CONSTRAINT agent_workspace_grants_pkey PRIMARY KEY (workspace_id, agent_id);

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.evaluation_cases
    ADD CONSTRAINT evaluation_cases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.evaluation_cases
    ADD CONSTRAINT evaluation_cases_suite_id_ordinal_key UNIQUE (suite_id, ordinal);

ALTER TABLE ONLY public.evaluation_cases
    ADD CONSTRAINT evaluation_cases_workspace_id_id_created_by_user_id_key UNIQUE (workspace_id, id, created_by_user_id);

ALTER TABLE ONLY public.evaluation_cases
    ADD CONSTRAINT evaluation_cases_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY public.evaluation_results
    ADD CONSTRAINT evaluation_results_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.evaluation_results
    ADD CONSTRAINT evaluation_results_run_id_case_id_key UNIQUE (run_id, case_id);

ALTER TABLE ONLY public.evaluation_runs
    ADD CONSTRAINT evaluation_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.evaluation_runs
    ADD CONSTRAINT evaluation_runs_workspace_id_id_created_by_user_id_key UNIQUE (workspace_id, id, created_by_user_id);

ALTER TABLE ONLY public.evaluation_runs
    ADD CONSTRAINT evaluation_runs_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY public.evaluation_suites
    ADD CONSTRAINT evaluation_suites_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.evaluation_suites
    ADD CONSTRAINT evaluation_suites_workspace_id_created_by_user_id_name_vers_key UNIQUE (workspace_id, created_by_user_id, name, version);

ALTER TABLE ONLY public.evaluation_suites
    ADD CONSTRAINT evaluation_suites_workspace_id_id_created_by_user_id_key UNIQUE (workspace_id, id, created_by_user_id);

ALTER TABLE ONLY public.evaluation_suites
    ADD CONSTRAINT evaluation_suites_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_provider_subject_key UNIQUE (provider, subject);

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (workspace_id, user_id);

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE ONLY public.memory_chunks
    ADD CONSTRAINT memory_chunks_memory_id_ordinal_key UNIQUE (memory_id, ordinal);

ALTER TABLE ONLY public.memory_chunks
    ADD CONSTRAINT memory_chunks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);

CREATE INDEX evaluation_cases_suite_idx ON public.evaluation_cases USING btree (workspace_id, created_by_user_id, suite_id, ordinal, id);

CREATE INDEX evaluation_runs_suite_idx ON public.evaluation_runs USING btree (workspace_id, created_by_user_id, suite_id, started_at DESC, id);

CREATE INDEX evaluation_suites_workspace_idx ON public.evaluation_suites USING btree (workspace_id, created_by_user_id, updated_at DESC, id);

CREATE INDEX memories_owner_updated_idx ON public.memories USING btree (workspace_id, owner_user_id, updated_at DESC);

CREATE INDEX memories_workspace_updated_idx ON public.memories USING btree (workspace_id, updated_at DESC, id);

CREATE INDEX memory_chunks_embedding_cosine_idx ON public.memory_chunks USING hnsw (embedding public.vector_cosine_ops) WHERE (embedding IS NOT NULL);

CREATE INDEX memory_chunks_search_idx ON public.memory_chunks USING gin (search_vector);

CREATE INDEX memory_chunks_workspace_memory_idx ON public.memory_chunks USING btree (workspace_id, memory_id);

CREATE TRIGGER memories_protect_identity BEFORE UPDATE ON public.memories FOR EACH ROW EXECUTE FUNCTION lore.protect_memory_identity();

ALTER TABLE ONLY public.agent_credentials
    ADD CONSTRAINT agent_credentials_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_workspace_grants
    ADD CONSTRAINT agent_workspace_grants_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_workspace_grants
    ADD CONSTRAINT agent_workspace_grants_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.evaluation_cases
    ADD CONSTRAINT evaluation_cases_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.evaluation_cases
    ADD CONSTRAINT evaluation_cases_workspace_id_suite_id_created_by_user_id_fkey FOREIGN KEY (workspace_id, suite_id, created_by_user_id) REFERENCES public.evaluation_suites(workspace_id, id, created_by_user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.evaluation_results
    ADD CONSTRAINT evaluation_results_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.evaluation_results
    ADD CONSTRAINT evaluation_results_workspace_id_case_id_created_by_user_id_fkey FOREIGN KEY (workspace_id, case_id, created_by_user_id) REFERENCES public.evaluation_cases(workspace_id, id, created_by_user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.evaluation_results
    ADD CONSTRAINT evaluation_results_workspace_id_run_id_created_by_user_id_fkey FOREIGN KEY (workspace_id, run_id, created_by_user_id) REFERENCES public.evaluation_runs(workspace_id, id, created_by_user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.evaluation_runs
    ADD CONSTRAINT evaluation_runs_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.evaluation_runs
    ADD CONSTRAINT evaluation_runs_workspace_id_suite_id_created_by_user_id_fkey FOREIGN KEY (workspace_id, suite_id, created_by_user_id) REFERENCES public.evaluation_suites(workspace_id, id, created_by_user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.evaluation_suites
    ADD CONSTRAINT evaluation_suites_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.evaluation_suites
    ADD CONSTRAINT evaluation_suites_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.identities
    ADD CONSTRAINT identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_created_by_agent_fk FOREIGN KEY (created_by_agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memory_chunks
    ADD CONSTRAINT memory_chunks_workspace_id_memory_id_fkey FOREIGN KEY (workspace_id, memory_id) REFERENCES public.memories(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE public.agent_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_credentials_insert ON public.agent_credentials FOR INSERT WITH CHECK ((lore.agent_owned_by_current_user(agent_id) AND (lore.current_agent_id() IS NULL)));

CREATE POLICY agent_credentials_select ON public.agent_credentials FOR SELECT USING ((lore.agent_owned_by_current_user(agent_id) AND (lore.current_agent_id() IS NULL)));

CREATE POLICY agent_credentials_update ON public.agent_credentials FOR UPDATE USING ((lore.agent_owned_by_current_user(agent_id) AND (lore.current_agent_id() IS NULL))) WITH CHECK ((lore.agent_owned_by_current_user(agent_id) AND (lore.current_agent_id() IS NULL)));

CREATE POLICY agent_grants_delete ON public.agent_workspace_grants FOR DELETE USING (((workspace_id = lore.current_workspace_id()) AND (lore.current_agent_id() IS NULL) AND lore.is_active_member(workspace_id) AND lore.agent_owned_by_current_user(agent_id)));

CREATE POLICY agent_grants_insert ON public.agent_workspace_grants FOR INSERT WITH CHECK (((workspace_id = lore.current_workspace_id()) AND (lore.current_agent_id() IS NULL) AND lore.is_active_member(workspace_id) AND lore.agent_owned_by_current_user(agent_id)));

CREATE POLICY agent_grants_select ON public.agent_workspace_grants FOR SELECT USING (((workspace_id = lore.current_workspace_id()) AND (lore.current_agent_id() IS NULL) AND lore.agent_owned_by_current_user(agent_id)));

CREATE POLICY agent_grants_update ON public.agent_workspace_grants FOR UPDATE USING (((workspace_id = lore.current_workspace_id()) AND (lore.current_agent_id() IS NULL) AND lore.is_active_member(workspace_id) AND lore.agent_owned_by_current_user(agent_id))) WITH CHECK (((workspace_id = lore.current_workspace_id()) AND (lore.current_agent_id() IS NULL) AND lore.is_active_member(workspace_id) AND lore.agent_owned_by_current_user(agent_id)));

ALTER TABLE public.agent_workspace_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY agents_delete ON public.agents FOR DELETE USING (((owner_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL)));

CREATE POLICY agents_insert ON public.agents FOR INSERT WITH CHECK (((owner_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL)));

CREATE POLICY agents_select ON public.agents FOR SELECT USING (((owner_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL)));

CREATE POLICY agents_update ON public.agents FOR UPDATE USING (((owner_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL))) WITH CHECK (((owner_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL)));

ALTER TABLE public.evaluation_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY evaluation_cases_all ON public.evaluation_cases USING (lore.can_manage_evaluations(workspace_id, created_by_user_id)) WITH CHECK (lore.can_manage_evaluations(workspace_id, created_by_user_id));

ALTER TABLE public.evaluation_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY evaluation_results_all ON public.evaluation_results USING (lore.can_manage_evaluations(workspace_id, created_by_user_id)) WITH CHECK (lore.can_manage_evaluations(workspace_id, created_by_user_id));

ALTER TABLE public.evaluation_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY evaluation_runs_all ON public.evaluation_runs USING (lore.can_manage_evaluations(workspace_id, created_by_user_id)) WITH CHECK (lore.can_manage_evaluations(workspace_id, created_by_user_id));

ALTER TABLE public.evaluation_suites ENABLE ROW LEVEL SECURITY;

CREATE POLICY evaluation_suites_all ON public.evaluation_suites USING (lore.can_manage_evaluations(workspace_id, created_by_user_id)) WITH CHECK (lore.can_manage_evaluations(workspace_id, created_by_user_id));

ALTER TABLE public.identities ENABLE ROW LEVEL SECURITY;

CREATE POLICY identities_select ON public.identities FOR SELECT USING ((user_id = lore.current_user_id()));

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY memberships_delete ON public.memberships FOR DELETE USING (lore.can_manage_workspace(workspace_id));

CREATE POLICY memberships_insert ON public.memberships FOR INSERT WITH CHECK (lore.can_manage_workspace(workspace_id));

CREATE POLICY memberships_select ON public.memberships FOR SELECT USING (((workspace_id = lore.current_workspace_id()) AND lore.is_active_member(workspace_id)));

CREATE POLICY memberships_update ON public.memberships FOR UPDATE USING (lore.can_manage_workspace(workspace_id)) WITH CHECK (lore.can_manage_workspace(workspace_id));

ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY memories_delete ON public.memories FOR DELETE USING (lore.can_write_memory(workspace_id, owner_user_id));

CREATE POLICY memories_insert ON public.memories FOR INSERT WITH CHECK ((lore.can_write_memory(workspace_id, owner_user_id) AND (NOT (created_by_agent_id IS DISTINCT FROM lore.current_agent_id()))));

CREATE POLICY memories_select ON public.memories FOR SELECT USING (lore.can_read_memory(workspace_id, owner_user_id, scope));

CREATE POLICY memories_update ON public.memories FOR UPDATE USING (lore.can_write_memory(workspace_id, owner_user_id)) WITH CHECK (lore.can_write_memory(workspace_id, owner_user_id));

ALTER TABLE public.memory_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY memory_chunks_delete ON public.memory_chunks FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)))));

CREATE POLICY memory_chunks_insert ON public.memory_chunks FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)))));

CREATE POLICY memory_chunks_select ON public.memory_chunks FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)))));

CREATE POLICY memory_chunks_update ON public.memory_chunks FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)))));

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select ON public.users FOR SELECT USING (lore.can_read_user(id));

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspaces_select ON public.workspaces FOR SELECT USING (((id = lore.current_workspace_id()) AND lore.is_active_member(id)));

GRANT USAGE ON SCHEMA lore TO lore_app;

GRANT ALL ON FUNCTION lore.agent_has_access(target_workspace_id uuid, required_permission public.agent_grant_permission) TO lore_app;

GRANT ALL ON FUNCTION lore.agent_owned_by_current_user(target_agent_id uuid) TO lore_app;

REVOKE ALL ON FUNCTION lore.authenticate_agent_credential(candidate_secret_hash text, target_workspace_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION lore.authenticate_agent_credential(candidate_secret_hash text, target_workspace_id uuid) TO lore_app;

GRANT ALL ON FUNCTION lore.can_manage_evaluations(target_workspace_id uuid, target_user_id uuid) TO lore_app;

GRANT ALL ON FUNCTION lore.can_manage_workspace(target_workspace_id uuid) TO lore_app;

REVOKE ALL ON FUNCTION lore.can_read_memory(target_workspace_id uuid, target_owner_user_id uuid, target_scope public.memory_scope) FROM PUBLIC;
GRANT ALL ON FUNCTION lore.can_read_memory(target_workspace_id uuid, target_owner_user_id uuid, target_scope public.memory_scope) TO lore_app;

REVOKE ALL ON FUNCTION lore.can_read_user(target_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION lore.can_read_user(target_user_id uuid) TO lore_app;

REVOKE ALL ON FUNCTION lore.can_write_memory(target_workspace_id uuid, target_owner_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION lore.can_write_memory(target_workspace_id uuid, target_owner_user_id uuid) TO lore_app;

REVOKE ALL ON FUNCTION lore.create_workspace(new_workspace_id uuid, workspace_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION lore.create_workspace(new_workspace_id uuid, workspace_name text) TO lore_app;

REVOKE ALL ON FUNCTION lore.current_agent_id() FROM PUBLIC;
GRANT ALL ON FUNCTION lore.current_agent_id() TO lore_app;

REVOKE ALL ON FUNCTION lore.current_user_id() FROM PUBLIC;
GRANT ALL ON FUNCTION lore.current_user_id() TO lore_app;

REVOKE ALL ON FUNCTION lore.current_workspace_id() FROM PUBLIC;
GRANT ALL ON FUNCTION lore.current_workspace_id() TO lore_app;

REVOKE ALL ON FUNCTION lore.is_active_member(target_workspace_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION lore.is_active_member(target_workspace_id uuid) TO lore_app;

REVOKE ALL ON FUNCTION lore.list_workspaces() FROM PUBLIC;
GRANT ALL ON FUNCTION lore.list_workspaces() TO lore_app;

GRANT ALL ON FUNCTION lore.protect_memory_identity() TO lore_app;

REVOKE ALL ON FUNCTION lore.register_identity(new_user_id uuid, new_identity_id uuid, identity_provider text, identity_subject text, user_display_name text, identity_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION lore.register_identity(new_user_id uuid, new_identity_id uuid, identity_provider text, identity_subject text, user_display_name text, identity_email text) TO lore_app;

REVOKE ALL ON FUNCTION lore.resolve_identity(identity_provider text, identity_subject text) FROM PUBLIC;
GRANT ALL ON FUNCTION lore.resolve_identity(identity_provider text, identity_subject text) TO lore_app;

GRANT INSERT,DELETE,UPDATE ON TABLE public.agent_credentials TO lore_app;

GRANT SELECT(id) ON TABLE public.agent_credentials TO lore_app;

GRANT SELECT(agent_id) ON TABLE public.agent_credentials TO lore_app;

GRANT SELECT(secret_prefix) ON TABLE public.agent_credentials TO lore_app;

GRANT SELECT(created_at) ON TABLE public.agent_credentials TO lore_app;

GRANT SELECT(last_used_at) ON TABLE public.agent_credentials TO lore_app;

GRANT SELECT(revoked_at) ON TABLE public.agent_credentials TO lore_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_workspace_grants TO lore_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agents TO lore_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.evaluation_cases TO lore_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.evaluation_results TO lore_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.evaluation_runs TO lore_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.evaluation_suites TO lore_app;

GRANT SELECT(id) ON TABLE public.identities TO lore_app;

GRANT SELECT(user_id) ON TABLE public.identities TO lore_app;

GRANT SELECT(provider) ON TABLE public.identities TO lore_app;

GRANT SELECT(subject) ON TABLE public.identities TO lore_app;

GRANT SELECT(email) ON TABLE public.identities TO lore_app;

GRANT SELECT(created_at) ON TABLE public.identities TO lore_app;

GRANT SELECT(updated_at) ON TABLE public.identities TO lore_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.memberships TO lore_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.memories TO lore_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.memory_chunks TO lore_app;

GRANT SELECT ON TABLE public.users TO lore_app;

GRANT SELECT ON TABLE public.workspaces TO lore_app;

RESET check_function_bodies;
