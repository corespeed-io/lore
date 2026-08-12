-- migrate:up
-- Lore v1 baseline. This is the complete schema for fresh installations.
SET check_function_bodies = false;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lore_app') THEN
    CREATE ROLE lore_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lore_maintenance') THEN
    CREATE ROLE lore_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
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
CREATE TYPE public.embedding_generation_status AS ENUM (
    'building',
    'active',
    'retiring',
    'failed'
);
CREATE TYPE public.episode_kind AS ENUM (
    'conversation',
    'workflow',
    'document',
    'event'
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
CREATE TYPE public.memory_embedding_job_status AS ENUM (
    'pending',
    'processing',
    'succeeded',
    'dead',
    'cancelled'
);
CREATE TYPE public.memory_proposal_kind AS ENUM (
    'create',
    'update'
);
CREATE TYPE public.memory_proposal_status AS ENUM (
    'pending',
    'accepted',
    'rejected'
);
CREATE TYPE public.memory_scope AS ENUM (
    'shared',
    'private'
);
CREATE TYPE public.observation_kind AS ENUM (
    'message',
    'tool_call',
    'tool_result',
    'document_fragment',
    'event'
);
CREATE FUNCTION lore.activate_embedding_generation(target_provider text, target_model text, target_revision text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.append_memory_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.append_memory_link_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.can_append_memory_proposal_evidence(target_workspace_id uuid, target_proposal_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.can_maintain_embedding(target_generation_id uuid, target_workspace_id uuid, target_memory_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT target_generation_id = lore.current_maintenance_generation_id()
    AND lore.can_maintain_memory(target_workspace_id, target_memory_id)
$$;
CREATE FUNCTION lore.can_maintain_memory(target_workspace_id uuid, target_memory_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.can_read_memory_proposal(target_workspace_id uuid, target_owner_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT target_workspace_id = lore.current_workspace_id()
    AND target_owner_user_id = lore.current_user_id()
    AND lore.current_agent_id() IS NULL
    AND lore.is_active_member(target_workspace_id)
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
CREATE FUNCTION lore.can_review_memory_proposal(target_workspace_id uuid, target_owner_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT lore.current_agent_id() IS NULL
    AND target_workspace_id = lore.current_workspace_id()
    AND target_owner_user_id = lore.current_user_id()
    AND lore.is_active_member(target_workspace_id)
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
CREATE FUNCTION lore.claim_memory_embedding_job(requested_job_id uuid, active_embedding_provider text, active_embedding_model text, active_embedding_revision text, new_lease_token uuid, lease_timeout_seconds integer) RETURNS TABLE(id uuid, workspace_id uuid, memory_id uuid, owner_user_id uuid, memory_scope public.memory_scope, memory_version integer, attempt_count smallint, chunks jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.current_maintenance_generation_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT job.generation_id
  FROM memory_embedding_jobs job
  WHERE job.id = lore.current_maintenance_job_id()
    AND job.lease_token = lore.current_maintenance_lease_token()
    AND job.status = 'processing'
$$;
CREATE FUNCTION lore.current_maintenance_job_id() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT nullif(current_setting('lore.maintenance_job_id', true), '')::uuid
$$;
CREATE FUNCTION lore.current_maintenance_lease_token() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT nullif(current_setting('lore.maintenance_lease_token', true), '')::uuid
$$;
CREATE FUNCTION lore.current_request_id() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT nullif(current_setting('lore.request_id', true), '')::uuid
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
CREATE FUNCTION lore.embedding_generation_report(target_provider text, target_model text, target_revision text) RETURNS TABLE(id uuid, status public.embedding_generation_status, eligible_chunks bigint, embedded_chunks bigint, missing_chunks bigint, pending_jobs bigint, dead_jobs bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.enqueue_stale_memory_embedding_jobs(active_embedding_provider text, active_embedding_model text, active_embedding_revision text, job_limit integer) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.ensure_embedding_generation(target_provider text, target_model text, target_dimensions integer, target_revision text) RETURNS TABLE(id uuid, status public.embedding_generation_status)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.extract_entity_aliases(input text) RETURNS text[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $_$
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
$_$;
COMMENT ON FUNCTION lore.extract_entity_aliases(input text) IS 'Deterministic exact alias index terms; never an inferred Memory or authorization signal.';
CREATE FUNCTION lore.finish_memory_embedding_job(target_job_id uuid, target_lease_token uuid, failure_detail text, retry_delay_seconds integer) RETURNS public.memory_embedding_job_status
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.list_pending_memory_embedding_jobs(active_embedding_provider text, active_embedding_model text, active_embedding_revision text, lease_timeout_seconds integer, job_limit integer) RETURNS TABLE(id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.lock_current_maintenance_memory() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.lock_reviewable_proposal_observations(target_workspace_id uuid, target_proposal_id uuid) RETURNS SETOF uuid
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.portable_core_capabilities() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.protect_memory_identity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
COMMENT ON FUNCTION lore.protect_memory_identity() IS 'Keeps Memory identity and provenance immutable while allowing an Agent foreign-key deletion to clear its provenance reference and advance the strong ETag version.';
CREATE FUNCTION lore.protect_memory_link_identity() RETURNS trigger
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
CREATE FUNCTION lore.protect_memory_proposal_review() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.prune_retiring_embedding_generations(retention_seconds integer DEFAULT 604800) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.purge_expired_portable_core_records() RETURNS TABLE(idempotency_records bigint, memory_event_records bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.record_episode(target_workspace_id uuid, target_owner_user_id uuid, target_actor_kind text, target_agent_id uuid, target_kind public.episode_kind, target_scope public.memory_scope, target_started_at timestamp with time zone, target_ended_at timestamp with time zone, target_observations json) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.remove_proposals_for_deleted_memory() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.scrub_deleted_episode_replay() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  DELETE FROM public.request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id
    AND replay.response_body #>> '{episode,id}' = OLD.id::text;
  RETURN OLD;
END
$$;
CREATE FUNCTION lore.scrub_deleted_memory_proposal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  DELETE FROM public.request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id
    AND replay.response_body #>> '{proposal,id}' = OLD.id::text;
  RETURN OLD;
END
$$;
SET default_tablespace = '';
SET default_table_access_method = heap;
CREATE TABLE public.memory_proposals (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    proposed_by_actor_kind text NOT NULL,
    proposed_by_agent_id uuid,
    kind public.memory_proposal_kind NOT NULL,
    target_memory_id uuid,
    base_memory_version integer,
    proposed_content text NOT NULL,
    proposed_scope public.memory_scope NOT NULL,
    proposed_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    changes_content boolean NOT NULL,
    changes_scope boolean NOT NULL,
    changes_metadata boolean NOT NULL,
    status public.memory_proposal_status DEFAULT 'pending'::public.memory_proposal_status NOT NULL,
    reviewed_by_user_id uuid,
    accepted_memory_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    CONSTRAINT memory_proposals_check CHECK (((proposed_by_actor_kind = 'agent'::text) OR (proposed_by_agent_id IS NULL))),
    CONSTRAINT memory_proposals_check1 CHECK ((((kind = 'create'::public.memory_proposal_kind) AND (target_memory_id IS NULL) AND (base_memory_version IS NULL) AND changes_content AND changes_scope AND changes_metadata) OR ((kind = 'update'::public.memory_proposal_kind) AND (target_memory_id IS NOT NULL) AND (base_memory_version > 0) AND (changes_content OR changes_scope OR changes_metadata)))),
    CONSTRAINT memory_proposals_check2 CHECK ((((status = 'pending'::public.memory_proposal_status) AND (reviewed_by_user_id IS NULL) AND (accepted_memory_id IS NULL) AND (reviewed_at IS NULL) AND (expires_at = (created_at + '30 days'::interval))) OR ((status = 'accepted'::public.memory_proposal_status) AND (reviewed_by_user_id IS NOT NULL) AND (accepted_memory_id IS NOT NULL) AND (reviewed_at IS NOT NULL) AND (expires_at = (reviewed_at + '30 days'::interval))) OR ((status = 'rejected'::public.memory_proposal_status) AND (reviewed_by_user_id IS NOT NULL) AND (accepted_memory_id IS NULL) AND (reviewed_at IS NOT NULL) AND (expires_at = (reviewed_at + '30 days'::interval))))),
    CONSTRAINT memory_proposals_proposed_by_actor_kind_check CHECK ((proposed_by_actor_kind = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT memory_proposals_proposed_content_check CHECK ((btrim(proposed_content) <> ''::text)),
    CONSTRAINT memory_proposals_proposed_metadata_check CHECK ((jsonb_typeof(proposed_metadata) = 'object'::text))
);
COMMENT ON TABLE public.memory_proposals IS 'Owner-private, non-canonical review state. Content expires after 30 days and is removed with its target or accepted Memory.';
COMMENT ON COLUMN public.memory_proposals.expires_at IS 'Hard content-retention boundary: 30 days after submission or the latest review.';
CREATE FUNCTION lore.submit_memory_proposal(target_workspace_id uuid, target_owner_user_id uuid, target_actor_kind text, target_agent_id uuid, target_kind public.memory_proposal_kind, target_memory_id uuid, target_base_memory_version integer, target_content text, target_scope public.memory_scope, target_metadata jsonb, target_changes_content boolean, target_changes_scope boolean, target_changes_metadata boolean) RETURNS SETOF public.memory_proposals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE FUNCTION lore.validate_memory_proposal_target() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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
CREATE TABLE public.embedding_generations (
    id uuid NOT NULL,
    embedding_provider text NOT NULL,
    embedding_model text NOT NULL,
    embedding_dimensions integer NOT NULL,
    embedding_revision text NOT NULL,
    status public.embedding_generation_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    retired_at timestamp with time zone,
    validated_at timestamp with time zone,
    failure_detail text,
    CONSTRAINT embedding_generations_check CHECK ((((status = 'active'::public.embedding_generation_status) AND (activated_at IS NOT NULL) AND (retired_at IS NULL)) OR ((status = 'retiring'::public.embedding_generation_status) AND (activated_at IS NOT NULL) AND (retired_at IS NOT NULL)) OR ((status = ANY (ARRAY['building'::public.embedding_generation_status, 'failed'::public.embedding_generation_status])) AND (activated_at IS NULL)))),
    CONSTRAINT embedding_generations_embedding_dimensions_check CHECK ((embedding_dimensions = 1024)),
    CONSTRAINT embedding_generations_embedding_model_check CHECK ((btrim(embedding_model) <> ''::text)),
    CONSTRAINT embedding_generations_embedding_provider_check CHECK ((btrim(embedding_provider) <> ''::text)),
    CONSTRAINT embedding_generations_embedding_revision_check CHECK ((btrim(embedding_revision) <> ''::text)),
    CONSTRAINT embedding_generations_failure_detail_check CHECK (((failure_detail IS NULL) OR (length(failure_detail) <= 1000)))
);
CREATE TABLE public.episodes (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    recorded_by_actor_kind text NOT NULL,
    recorded_by_agent_id uuid,
    kind public.episode_kind NOT NULL,
    scope public.memory_scope DEFAULT 'private'::public.memory_scope NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT episodes_check CHECK ((ended_at >= started_at)),
    CONSTRAINT episodes_check1 CHECK (((recorded_by_actor_kind = 'agent'::text) OR (recorded_by_agent_id IS NULL))),
    CONSTRAINT episodes_recorded_by_actor_kind_check CHECK ((recorded_by_actor_kind = ANY (ARRAY['human'::text, 'agent'::text])))
);
COMMENT ON TABLE public.episodes IS 'Immutable evidence envelopes. Episodes group ordered Observations but are not canonical Memory.';
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
CREATE TABLE public.lore_system_state (
    singleton boolean DEFAULT true NOT NULL,
    deployment_id uuid DEFAULT gen_random_uuid() NOT NULL,
    schema_revision integer NOT NULL,
    api_version text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lore_system_state_api_version_check CHECK ((btrim(api_version) <> ''::text)),
    CONSTRAINT lore_system_state_schema_revision_check CHECK ((schema_revision > 0)),
    CONSTRAINT lore_system_state_singleton_check CHECK (singleton)
);
INSERT INTO public.lore_system_state (schema_revision, api_version)
VALUES (1, 'v1');
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
CREATE TABLE public.memory_chunk_embeddings (
    generation_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    chunk_id uuid NOT NULL,
    embedding public.vector(1024) NOT NULL,
    embedded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_chunk_embeddings_embedding_check CHECK ((public.vector_dims(embedding) = 1024))
);
COMMENT ON TABLE public.memory_chunk_embeddings IS 'Generation-scoped vectors; incompatible spaces are never searched together.';
CREATE TABLE public.memory_chunks (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    ordinal integer NOT NULL,
    content text NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding public.vector(1024),
    embedding_model text,
    embedded_at timestamp with time zone,
    embedding_provider text,
    embedding_revision text,
    search_vector_english tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED,
    entity_aliases text[] GENERATED ALWAYS AS (lore.extract_entity_aliases(content)) STORED,
    CONSTRAINT memory_chunks_content_check CHECK ((btrim(content) <> ''::text)),
    CONSTRAINT memory_chunks_embedding_state_check CHECK ((((embedding IS NULL) AND (embedding_provider IS NULL) AND (embedding_model IS NULL) AND (embedding_revision IS NULL) AND (embedded_at IS NULL)) OR ((embedding IS NOT NULL) AND (btrim(embedding_provider) <> ''::text) AND (btrim(embedding_model) <> ''::text) AND (btrim(embedding_revision) <> ''::text) AND (public.vector_dims(embedding) = 1024) AND (embedded_at IS NOT NULL)))),
    CONSTRAINT memory_chunks_ordinal_check CHECK ((ordinal >= 0))
);
CREATE TABLE public.memory_embedding_jobs (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    memory_scope public.memory_scope NOT NULL,
    memory_version integer NOT NULL,
    embedding_provider text NOT NULL,
    embedding_model text NOT NULL,
    embedding_revision text NOT NULL,
    status public.memory_embedding_job_status DEFAULT 'pending'::public.memory_embedding_job_status NOT NULL,
    attempt_count smallint DEFAULT 0 NOT NULL,
    max_attempts smallint DEFAULT 8 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_token uuid,
    leased_at timestamp with time zone,
    last_error text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    generation_id uuid,
    CONSTRAINT memory_embedding_jobs_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT memory_embedding_jobs_check CHECK ((((status = 'pending'::public.memory_embedding_job_status) AND (lease_token IS NULL) AND (leased_at IS NULL) AND (completed_at IS NULL)) OR ((status = 'processing'::public.memory_embedding_job_status) AND (lease_token IS NOT NULL) AND (leased_at IS NOT NULL) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['succeeded'::public.memory_embedding_job_status, 'dead'::public.memory_embedding_job_status, 'cancelled'::public.memory_embedding_job_status])) AND (lease_token IS NULL) AND (leased_at IS NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT memory_embedding_jobs_embedding_model_check CHECK ((btrim(embedding_model) <> ''::text)),
    CONSTRAINT memory_embedding_jobs_embedding_provider_check CHECK ((btrim(embedding_provider) <> ''::text)),
    CONSTRAINT memory_embedding_jobs_embedding_revision_check CHECK ((btrim(embedding_revision) <> ''::text)),
    CONSTRAINT memory_embedding_jobs_last_error_check CHECK (((last_error IS NULL) OR (length(last_error) <= 1000))),
    CONSTRAINT memory_embedding_jobs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 32))),
    CONSTRAINT memory_embedding_jobs_memory_version_check CHECK ((memory_version > 0))
);
CREATE TABLE public.memory_events (
    sequence bigint NOT NULL,
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    memory_scope public.memory_scope NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    source_memory_id uuid,
    related_memory_id uuid,
    event_type text NOT NULL,
    actor_user_id uuid,
    actor_agent_id uuid,
    request_id uuid,
    before_version integer,
    after_version integer,
    changed_fields text[] DEFAULT ARRAY[]::text[] NOT NULL,
    before_content_sha256 text,
    after_content_sha256 text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '90 days'::interval) NOT NULL,
    CONSTRAINT memory_events_after_content_sha256_check CHECK (((after_content_sha256 IS NULL) OR (after_content_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT memory_events_before_content_sha256_check CHECK (((before_content_sha256 IS NULL) OR (before_content_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT memory_events_check CHECK ((((resource_type = 'memory'::text) AND (source_memory_id IS NULL) AND (related_memory_id IS NULL)) OR ((resource_type = 'memory_link'::text) AND (source_memory_id IS NOT NULL) AND (related_memory_id IS NOT NULL)))),
    CONSTRAINT memory_events_event_type_check CHECK ((event_type = ANY (ARRAY['memory.created'::text, 'memory.updated'::text, 'memory.deleted'::text, 'memory_link.created'::text, 'memory_link.updated'::text, 'memory_link.deleted'::text]))),
    CONSTRAINT memory_events_resource_type_check CHECK ((resource_type = ANY (ARRAY['memory'::text, 'memory_link'::text])))
);
COMMENT ON TABLE public.memory_events IS 'Content-free transactional mutation outbox and bounded deletion tombstones.';
ALTER TABLE public.memory_events ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.memory_events_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.memory_import_provenance (
    workspace_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    import_id uuid NOT NULL,
    source_memory_id uuid NOT NULL,
    source_owner_user_id uuid NOT NULL,
    source_created_at timestamp with time zone NOT NULL,
    source_updated_at timestamp with time zone NOT NULL
);
CREATE TABLE public.memory_links (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_memory_id uuid NOT NULL,
    target_memory_id uuid NOT NULL,
    kind text NOT NULL,
    weight real DEFAULT 1 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_links_check CHECK ((source_memory_id <> target_memory_id)),
    CONSTRAINT memory_links_kind_check CHECK (((btrim(kind) <> ''::text) AND (length(kind) <= 64))),
    CONSTRAINT memory_links_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT memory_links_weight_check CHECK (((weight >= (0)::double precision) AND (weight <= (1)::double precision)))
);
CREATE TABLE public.memory_proposal_evidence (
    workspace_id uuid NOT NULL,
    proposal_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    ordinal integer NOT NULL,
    CONSTRAINT memory_proposal_evidence_ordinal_check CHECK ((ordinal >= 0))
);
CREATE TABLE public.memory_proposal_observation_evidence (
    workspace_id uuid NOT NULL,
    proposal_id uuid NOT NULL,
    observation_id uuid,
    observation_reference_id uuid CONSTRAINT memory_proposal_observation_e_observation_reference_id_not_null NOT NULL,
    ordinal integer NOT NULL,
    CONSTRAINT memory_proposal_observation_evidence_check CHECK (((observation_id IS NULL) OR (observation_id = observation_reference_id))),
    CONSTRAINT memory_proposal_observation_evidence_ordinal_check CHECK ((ordinal >= 0))
);
COMMENT ON TABLE public.memory_proposal_observation_evidence IS 'Owner-private Proposal evidence references. Explicit forget nulls the live pointer but retains the content-free cited id until Proposal expiry.';
CREATE TABLE public.observations (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    ordinal integer NOT NULL,
    kind public.observation_kind NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    payload_sha256 text NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT observations_content_check CHECK (((btrim(content) <> ''::text) AND (length(content) <= 100000))),
    CONSTRAINT observations_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT observations_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT observations_payload_sha256_check CHECK ((payload_sha256 ~ '^[0-9a-f]{64}$'::text))
);
COMMENT ON TABLE public.observations IS 'Immutable, durable evidence records. Content remains until its Episode is explicitly forgotten.';
CREATE TABLE public.request_idempotency_records (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    actor_kind text NOT NULL,
    actor_id uuid NOT NULL,
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    request_sha256 text NOT NULL,
    status text DEFAULT 'in_progress'::text NOT NULL,
    response_status smallint,
    response_body jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
    CONSTRAINT request_idempotency_records_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['user'::text, 'agent'::text]))),
    CONSTRAINT request_idempotency_records_check CHECK ((((status = 'in_progress'::text) AND (response_status IS NULL) AND (response_body IS NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (response_status IS NOT NULL) AND (response_body IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT request_idempotency_records_idempotency_key_check CHECK (((btrim(idempotency_key) <> ''::text) AND (length(idempotency_key) <= 128))),
    CONSTRAINT request_idempotency_records_operation_check CHECK (((btrim(operation) <> ''::text) AND (length(operation) <= 128))),
    CONSTRAINT request_idempotency_records_request_sha256_check CHECK ((request_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT request_idempotency_records_response_status_check CHECK (((response_status >= 100) AND (response_status <= 599))),
    CONSTRAINT request_idempotency_records_status_check CHECK ((status = ANY (ARRAY['in_progress'::text, 'completed'::text])))
);
COMMENT ON TABLE public.request_idempotency_records IS 'Actor-scoped replay ledger; request payloads are represented only by SHA-256 hashes.';
CREATE TABLE public.users (
    id uuid NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_display_name_check CHECK ((btrim(display_name) <> ''::text))
);
CREATE TABLE public.workspace_imports (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    imported_by_user_id uuid NOT NULL,
    archive_sha256 text NOT NULL,
    source_deployment_id uuid NOT NULL,
    source_workspace_id uuid NOT NULL,
    summary jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_imports_archive_sha256_check CHECK ((archive_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_imports_summary_check CHECK ((jsonb_typeof(summary) = 'object'::text))
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
ALTER TABLE ONLY public.embedding_generations
    ADD CONSTRAINT embedding_generations_embedding_provider_embedding_model_em_key UNIQUE (embedding_provider, embedding_model, embedding_dimensions, embedding_revision);
ALTER TABLE ONLY public.embedding_generations
    ADD CONSTRAINT embedding_generations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.episodes
    ADD CONSTRAINT episodes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.episodes
    ADD CONSTRAINT episodes_workspace_id_id_key UNIQUE (workspace_id, id);
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
ALTER TABLE ONLY public.lore_system_state
    ADD CONSTRAINT lore_system_state_pkey PRIMARY KEY (singleton);
ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (workspace_id, user_id);
ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE ONLY public.memory_chunk_embeddings
    ADD CONSTRAINT memory_chunk_embeddings_pkey PRIMARY KEY (generation_id, chunk_id);
ALTER TABLE ONLY public.memory_chunks
    ADD CONSTRAINT memory_chunks_memory_id_ordinal_key UNIQUE (memory_id, ordinal);
ALTER TABLE ONLY public.memory_chunks
    ADD CONSTRAINT memory_chunks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.memory_embedding_jobs
    ADD CONSTRAINT memory_embedding_jobs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.memory_embedding_jobs
    ADD CONSTRAINT memory_embedding_jobs_workspace_id_memory_id_memory_version_key UNIQUE (workspace_id, memory_id, memory_version, embedding_provider, embedding_model, embedding_revision);
ALTER TABLE ONLY public.memory_events
    ADD CONSTRAINT memory_events_id_key UNIQUE (id);
ALTER TABLE ONLY public.memory_events
    ADD CONSTRAINT memory_events_pkey PRIMARY KEY (sequence);
ALTER TABLE ONLY public.memory_import_provenance
    ADD CONSTRAINT memory_import_provenance_pkey PRIMARY KEY (workspace_id, memory_id);
ALTER TABLE ONLY public.memory_links
    ADD CONSTRAINT memory_links_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.memory_links
    ADD CONSTRAINT memory_links_workspace_id_source_memory_id_target_memory_id_key UNIQUE (workspace_id, source_memory_id, target_memory_id, kind);
ALTER TABLE ONLY public.memory_proposal_evidence
    ADD CONSTRAINT memory_proposal_evidence_pkey PRIMARY KEY (proposal_id, memory_id);
ALTER TABLE ONLY public.memory_proposal_evidence
    ADD CONSTRAINT memory_proposal_evidence_proposal_id_ordinal_key UNIQUE (proposal_id, ordinal);
ALTER TABLE ONLY public.memory_proposal_observation_evidence
    ADD CONSTRAINT memory_proposal_observation_evidence_pkey PRIMARY KEY (proposal_id, observation_reference_id);
ALTER TABLE ONLY public.memory_proposal_observation_evidence
    ADD CONSTRAINT memory_proposal_observation_evidence_proposal_id_ordinal_key UNIQUE (proposal_id, ordinal);
ALTER TABLE ONLY public.memory_proposals
    ADD CONSTRAINT memory_proposals_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.memory_proposals
    ADD CONSTRAINT memory_proposals_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_episode_id_ordinal_key UNIQUE (episode_id, ordinal);
ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE ONLY public.request_idempotency_records
    ADD CONSTRAINT request_idempotency_records_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.request_idempotency_records
    ADD CONSTRAINT request_idempotency_records_workspace_id_actor_kind_actor_i_key UNIQUE (workspace_id, actor_kind, actor_id, operation, idempotency_key);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.workspace_imports
    ADD CONSTRAINT workspace_imports_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.workspace_imports
    ADD CONSTRAINT workspace_imports_workspace_id_imported_by_user_id_archive__key UNIQUE (workspace_id, imported_by_user_id, archive_sha256);
ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX embedding_generations_one_active_idx ON public.embedding_generations USING btree (status) WHERE (status = 'active'::public.embedding_generation_status);
CREATE INDEX episodes_owner_created_idx ON public.episodes USING btree (workspace_id, owner_user_id, created_at DESC, id);
CREATE INDEX episodes_workspace_created_idx ON public.episodes USING btree (workspace_id, created_at DESC, id);
CREATE INDEX evaluation_cases_suite_idx ON public.evaluation_cases USING btree (workspace_id, created_by_user_id, suite_id, ordinal, id);
CREATE INDEX evaluation_runs_suite_idx ON public.evaluation_runs USING btree (workspace_id, created_by_user_id, suite_id, started_at DESC, id);
CREATE INDEX evaluation_suites_workspace_idx ON public.evaluation_suites USING btree (workspace_id, created_by_user_id, updated_at DESC, id);
CREATE INDEX memories_created_by_agent_idx ON public.memories USING btree (created_by_agent_id) WHERE (created_by_agent_id IS NOT NULL);
CREATE INDEX memories_metadata_gin_idx ON public.memories USING gin (metadata jsonb_path_ops);
CREATE INDEX memories_owner_updated_idx ON public.memories USING btree (workspace_id, owner_user_id, updated_at DESC);
CREATE INDEX memories_workspace_updated_idx ON public.memories USING btree (workspace_id, updated_at DESC, id);
CREATE INDEX memory_chunk_embeddings_cosine_idx ON public.memory_chunk_embeddings USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');
CREATE INDEX memory_chunk_embeddings_workspace_memory_idx ON public.memory_chunk_embeddings USING btree (workspace_id, memory_id, generation_id);
CREATE INDEX memory_chunks_embedding_cosine_idx ON public.memory_chunks USING hnsw (embedding public.vector_cosine_ops) WHERE (embedding IS NOT NULL);
CREATE INDEX memory_chunks_entity_aliases_idx ON public.memory_chunks USING gin (entity_aliases);
CREATE INDEX memory_chunks_search_english_idx ON public.memory_chunks USING gin (search_vector_english);
CREATE INDEX memory_chunks_search_idx ON public.memory_chunks USING gin (search_vector);
CREATE INDEX memory_chunks_workspace_memory_idx ON public.memory_chunks USING btree (workspace_id, memory_id);
CREATE INDEX memory_embedding_jobs_generation_status_idx ON public.memory_embedding_jobs USING btree (generation_id, status, available_at, created_at, id);
CREATE INDEX memory_embedding_jobs_pending_idx ON public.memory_embedding_jobs USING btree (embedding_provider, embedding_model, embedding_revision, available_at, created_at, id) WHERE (status = ANY (ARRAY['pending'::public.memory_embedding_job_status, 'processing'::public.memory_embedding_job_status]));
CREATE INDEX memory_embedding_jobs_terminal_completed_idx ON public.memory_embedding_jobs USING btree (completed_at) WHERE (status = ANY (ARRAY['succeeded'::public.memory_embedding_job_status, 'dead'::public.memory_embedding_job_status, 'cancelled'::public.memory_embedding_job_status]));
CREATE INDEX memory_events_expiry_idx ON public.memory_events USING btree (expires_at);
CREATE INDEX memory_events_workspace_sequence_idx ON public.memory_events USING btree (workspace_id, sequence);
CREATE INDEX memory_links_workspace_source_idx ON public.memory_links USING btree (workspace_id, source_memory_id);
CREATE INDEX memory_links_workspace_target_idx ON public.memory_links USING btree (workspace_id, target_memory_id);
CREATE INDEX memory_proposal_evidence_memory_idx ON public.memory_proposal_evidence USING btree (workspace_id, memory_id, proposal_id);
CREATE INDEX memory_proposal_observation_evidence_observation_idx ON public.memory_proposal_observation_evidence USING btree (workspace_id, observation_id, proposal_id);
CREATE INDEX memory_proposals_expiry_idx ON public.memory_proposals USING btree (expires_at);
CREATE INDEX memory_proposals_owner_status_idx ON public.memory_proposals USING btree (workspace_id, owner_user_id, status, created_at DESC, id);
CREATE INDEX observations_episode_idx ON public.observations USING btree (workspace_id, episode_id, ordinal);
CREATE INDEX request_idempotency_records_expiry_idx ON public.request_idempotency_records USING btree (expires_at);
CREATE TRIGGER episodes_scrub_idempotency AFTER DELETE ON public.episodes FOR EACH ROW EXECUTE FUNCTION lore.scrub_deleted_episode_replay();
CREATE TRIGGER memories_append_event_delete BEFORE DELETE ON public.memories FOR EACH ROW EXECUTE FUNCTION lore.append_memory_event();
CREATE TRIGGER memories_append_event_insert_update AFTER INSERT OR UPDATE ON public.memories FOR EACH ROW EXECUTE FUNCTION lore.append_memory_event();
CREATE TRIGGER memories_protect_identity BEFORE UPDATE ON public.memories FOR EACH ROW EXECUTE FUNCTION lore.protect_memory_identity();
CREATE TRIGGER memories_remove_proposals_before_delete BEFORE DELETE ON public.memories FOR EACH ROW EXECUTE FUNCTION lore.remove_proposals_for_deleted_memory();
CREATE TRIGGER memory_links_append_event_delete BEFORE DELETE ON public.memory_links FOR EACH ROW EXECUTE FUNCTION lore.append_memory_link_event();
CREATE TRIGGER memory_links_append_event_insert_update AFTER INSERT OR UPDATE ON public.memory_links FOR EACH ROW EXECUTE FUNCTION lore.append_memory_link_event();
CREATE TRIGGER memory_links_protect_identity BEFORE UPDATE ON public.memory_links FOR EACH ROW EXECUTE FUNCTION lore.protect_memory_link_identity();
CREATE TRIGGER memory_proposals_protect_review BEFORE UPDATE ON public.memory_proposals FOR EACH ROW EXECUTE FUNCTION lore.protect_memory_proposal_review();
CREATE TRIGGER memory_proposals_scrub_idempotency AFTER DELETE ON public.memory_proposals FOR EACH ROW EXECUTE FUNCTION lore.scrub_deleted_memory_proposal();
CREATE TRIGGER memory_proposals_validate_target BEFORE INSERT ON public.memory_proposals FOR EACH ROW EXECUTE FUNCTION lore.validate_memory_proposal_target();
ALTER TABLE ONLY public.agent_credentials
    ADD CONSTRAINT agent_credentials_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.agent_workspace_grants
    ADD CONSTRAINT agent_workspace_grants_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.agent_workspace_grants
    ADD CONSTRAINT agent_workspace_grants_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.episodes
    ADD CONSTRAINT episodes_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.episodes
    ADD CONSTRAINT episodes_recorded_by_agent_id_fkey FOREIGN KEY (recorded_by_agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.episodes
    ADD CONSTRAINT episodes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
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
ALTER TABLE ONLY public.memory_chunk_embeddings
    ADD CONSTRAINT memory_chunk_embeddings_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES public.memory_chunks(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_chunk_embeddings
    ADD CONSTRAINT memory_chunk_embeddings_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES public.embedding_generations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_chunk_embeddings
    ADD CONSTRAINT memory_chunk_embeddings_workspace_id_memory_id_fkey FOREIGN KEY (workspace_id, memory_id) REFERENCES public.memories(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_chunks
    ADD CONSTRAINT memory_chunks_workspace_id_memory_id_fkey FOREIGN KEY (workspace_id, memory_id) REFERENCES public.memories(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_embedding_jobs
    ADD CONSTRAINT memory_embedding_jobs_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES public.embedding_generations(id);
ALTER TABLE ONLY public.memory_embedding_jobs
    ADD CONSTRAINT memory_embedding_jobs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_embedding_jobs
    ADD CONSTRAINT memory_embedding_jobs_workspace_id_memory_id_fkey FOREIGN KEY (workspace_id, memory_id) REFERENCES public.memories(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_import_provenance
    ADD CONSTRAINT memory_import_provenance_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.workspace_imports(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_import_provenance
    ADD CONSTRAINT memory_import_provenance_workspace_id_memory_id_fkey FOREIGN KEY (workspace_id, memory_id) REFERENCES public.memories(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_links
    ADD CONSTRAINT memory_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_links
    ADD CONSTRAINT memory_links_workspace_id_source_memory_id_fkey FOREIGN KEY (workspace_id, source_memory_id) REFERENCES public.memories(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_links
    ADD CONSTRAINT memory_links_workspace_id_target_memory_id_fkey FOREIGN KEY (workspace_id, target_memory_id) REFERENCES public.memories(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_proposal_evidence
    ADD CONSTRAINT memory_proposal_evidence_workspace_id_memory_id_fkey FOREIGN KEY (workspace_id, memory_id) REFERENCES public.memories(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_proposal_evidence
    ADD CONSTRAINT memory_proposal_evidence_workspace_id_proposal_id_fkey FOREIGN KEY (workspace_id, proposal_id) REFERENCES public.memory_proposals(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_proposal_observation_evidence
    ADD CONSTRAINT memory_proposal_observation_evide_workspace_id_proposal_id_fkey FOREIGN KEY (workspace_id, proposal_id) REFERENCES public.memory_proposals(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_proposal_observation_evidence
    ADD CONSTRAINT memory_proposal_observation_evidence_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES public.observations(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.memory_proposals
    ADD CONSTRAINT memory_proposals_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.memory_proposals
    ADD CONSTRAINT memory_proposals_proposed_by_agent_id_fkey FOREIGN KEY (proposed_by_agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.memory_proposals
    ADD CONSTRAINT memory_proposals_reviewed_by_user_id_fkey FOREIGN KEY (reviewed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.memory_proposals
    ADD CONSTRAINT memory_proposals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_workspace_id_episode_id_fkey FOREIGN KEY (workspace_id, episode_id) REFERENCES public.episodes(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE ONLY public.request_idempotency_records
    ADD CONSTRAINT request_idempotency_records_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.request_idempotency_records
    ADD CONSTRAINT request_idempotency_records_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.workspace_imports
    ADD CONSTRAINT workspace_imports_imported_by_user_id_fkey FOREIGN KEY (imported_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.workspace_imports
    ADD CONSTRAINT workspace_imports_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
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
ALTER TABLE public.embedding_generations ENABLE ROW LEVEL SECURITY;
CREATE POLICY embedding_generations_select ON public.embedding_generations FOR SELECT TO lore_app USING ((status = ANY (ARRAY['active'::public.embedding_generation_status, 'retiring'::public.embedding_generation_status])));
ALTER TABLE public.episodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY episodes_delete ON public.episodes FOR DELETE USING (lore.can_write_memory(workspace_id, owner_user_id));
CREATE POLICY episodes_select ON public.episodes FOR SELECT USING (lore.can_read_memory(workspace_id, owner_user_id, scope));
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
ALTER TABLE public.memory_chunk_embeddings ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_chunk_embeddings_delete ON public.memory_chunk_embeddings FOR DELETE TO lore_app USING ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.workspace_id = memory_chunk_embeddings.workspace_id) AND (memory.id = memory_chunk_embeddings.memory_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)))));
CREATE POLICY memory_chunk_embeddings_maintenance_all ON public.memory_chunk_embeddings TO lore_maintenance USING (lore.can_maintain_embedding(generation_id, workspace_id, memory_id)) WITH CHECK (lore.can_maintain_embedding(generation_id, workspace_id, memory_id));
CREATE POLICY memory_chunk_embeddings_select ON public.memory_chunk_embeddings FOR SELECT TO lore_app USING ((EXISTS ( SELECT 1
   FROM (public.embedding_generations generation
     JOIN public.memories memory ON (((memory.workspace_id = memory_chunk_embeddings.workspace_id) AND (memory.id = memory_chunk_embeddings.memory_id))))
  WHERE ((generation.id = memory_chunk_embeddings.generation_id) AND (generation.status = ANY (ARRAY['active'::public.embedding_generation_status, 'retiring'::public.embedding_generation_status])) AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)))));
ALTER TABLE public.memory_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_chunks_delete ON public.memory_chunks FOR DELETE TO lore_app USING ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)))));
CREATE POLICY memory_chunks_insert ON public.memory_chunks FOR INSERT TO lore_app WITH CHECK ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)))));
CREATE POLICY memory_chunks_maintenance_select ON public.memory_chunks FOR SELECT TO lore_maintenance USING (lore.can_maintain_memory(workspace_id, memory_id));
CREATE POLICY memory_chunks_maintenance_update ON public.memory_chunks FOR UPDATE TO lore_maintenance USING (lore.can_maintain_memory(workspace_id, memory_id)) WITH CHECK (lore.can_maintain_memory(workspace_id, memory_id));
CREATE POLICY memory_chunks_select ON public.memory_chunks FOR SELECT TO lore_app USING ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)))));
CREATE POLICY memory_chunks_update ON public.memory_chunks FOR UPDATE TO lore_app USING ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.id = memory_chunks.memory_id) AND (memory.workspace_id = memory_chunks.workspace_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)))));
ALTER TABLE public.memory_embedding_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_embedding_jobs_insert ON public.memory_embedding_jobs FOR INSERT TO lore_app WITH CHECK (((workspace_id = lore.current_workspace_id()) AND (EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.workspace_id = memory_embedding_jobs.workspace_id) AND (memory.id = memory_embedding_jobs.memory_id) AND (memory.owner_user_id = memory_embedding_jobs.owner_user_id) AND (memory.scope = memory_embedding_jobs.memory_scope) AND (memory.version = memory_embedding_jobs.memory_version) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id))))));
ALTER TABLE public.memory_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_events_select ON public.memory_events FOR SELECT TO lore_app USING ((((resource_type = 'memory'::text) AND ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.workspace_id = memory_events.workspace_id) AND (memory.id = memory_events.resource_id) AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)))) OR ((event_type = 'memory.deleted'::text) AND lore.can_read_memory(workspace_id, owner_user_id, memory_scope)))) OR ((resource_type = 'memory_link'::text) AND (EXISTS ( SELECT 1
   FROM (public.memories source_memory
     JOIN public.memories target_memory ON (((target_memory.workspace_id = source_memory.workspace_id) AND (target_memory.id = memory_events.related_memory_id))))
  WHERE ((source_memory.workspace_id = memory_events.workspace_id) AND (source_memory.id = memory_events.source_memory_id) AND lore.can_read_memory(source_memory.workspace_id, source_memory.owner_user_id, source_memory.scope) AND lore.can_read_memory(target_memory.workspace_id, target_memory.owner_user_id, target_memory.scope)))))));
ALTER TABLE public.memory_import_provenance ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_import_provenance_insert ON public.memory_import_provenance FOR INSERT TO lore_app WITH CHECK ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.workspace_id = memory_import_provenance.workspace_id) AND (memory.id = memory_import_provenance.memory_id) AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)))));
CREATE POLICY memory_import_provenance_select ON public.memory_import_provenance FOR SELECT TO lore_app USING ((EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.workspace_id = memory_import_provenance.workspace_id) AND (memory.id = memory_import_provenance.memory_id) AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)))));
ALTER TABLE public.memory_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_links_delete ON public.memory_links FOR DELETE USING (((workspace_id = lore.current_workspace_id()) AND (EXISTS ( SELECT 1
   FROM public.memories source
  WHERE ((source.workspace_id = memory_links.workspace_id) AND (source.id = memory_links.source_memory_id) AND lore.can_write_memory(source.workspace_id, source.owner_user_id))))));
CREATE POLICY memory_links_insert ON public.memory_links FOR INSERT WITH CHECK (((workspace_id = lore.current_workspace_id()) AND (EXISTS ( SELECT 1
   FROM (public.memories source
     JOIN public.memories target ON ((target.workspace_id = source.workspace_id)))
  WHERE ((source.workspace_id = memory_links.workspace_id) AND (source.id = memory_links.source_memory_id) AND (target.id = memory_links.target_memory_id) AND lore.can_write_memory(source.workspace_id, source.owner_user_id) AND lore.can_read_memory(target.workspace_id, target.owner_user_id, target.scope))))));
CREATE POLICY memory_links_select ON public.memory_links FOR SELECT USING (((workspace_id = lore.current_workspace_id()) AND (EXISTS ( SELECT 1
   FROM (public.memories source
     JOIN public.memories target ON ((target.workspace_id = source.workspace_id)))
  WHERE ((source.workspace_id = memory_links.workspace_id) AND (source.id = memory_links.source_memory_id) AND (target.id = memory_links.target_memory_id) AND lore.can_read_memory(source.workspace_id, source.owner_user_id, source.scope) AND lore.can_read_memory(target.workspace_id, target.owner_user_id, target.scope))))));
CREATE POLICY memory_links_update ON public.memory_links FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.memories source
  WHERE ((source.workspace_id = memory_links.workspace_id) AND (source.id = memory_links.source_memory_id) AND lore.can_write_memory(source.workspace_id, source.owner_user_id))))) WITH CHECK (((workspace_id = lore.current_workspace_id()) AND (EXISTS ( SELECT 1
   FROM (public.memories source
     JOIN public.memories target ON ((target.workspace_id = source.workspace_id)))
  WHERE ((source.workspace_id = memory_links.workspace_id) AND (source.id = memory_links.source_memory_id) AND (target.id = memory_links.target_memory_id) AND lore.can_write_memory(source.workspace_id, source.owner_user_id) AND lore.can_read_memory(target.workspace_id, target.owner_user_id, target.scope))))));
ALTER TABLE public.memory_proposal_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_proposal_evidence_insert ON public.memory_proposal_evidence FOR INSERT WITH CHECK ((lore.can_append_memory_proposal_evidence(workspace_id, proposal_id) AND (EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.id = memory_proposal_evidence.memory_id) AND (memory.workspace_id = memory_proposal_evidence.workspace_id) AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope))))));
CREATE POLICY memory_proposal_evidence_select ON public.memory_proposal_evidence FOR SELECT USING (((EXISTS ( SELECT 1
   FROM public.memory_proposals proposal
  WHERE ((proposal.id = memory_proposal_evidence.proposal_id) AND (proposal.workspace_id = memory_proposal_evidence.workspace_id)))) AND (EXISTS ( SELECT 1
   FROM public.memories memory
  WHERE ((memory.id = memory_proposal_evidence.memory_id) AND (memory.workspace_id = memory_proposal_evidence.workspace_id) AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope))))));
ALTER TABLE public.memory_proposal_observation_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_proposal_observation_evidence_insert ON public.memory_proposal_observation_evidence FOR INSERT WITH CHECK ((lore.can_append_memory_proposal_evidence(workspace_id, proposal_id) AND (observation_id = observation_reference_id) AND (EXISTS ( SELECT 1
   FROM public.observations observation
  WHERE ((observation.id = memory_proposal_observation_evidence.observation_id) AND (observation.workspace_id = memory_proposal_observation_evidence.workspace_id))))));
CREATE POLICY memory_proposal_observation_evidence_select ON public.memory_proposal_observation_evidence FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.memory_proposals proposal
  WHERE ((proposal.id = memory_proposal_observation_evidence.proposal_id) AND (proposal.workspace_id = memory_proposal_observation_evidence.workspace_id)))));
ALTER TABLE public.memory_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_proposals_insert ON public.memory_proposals FOR INSERT WITH CHECK ((lore.can_write_memory(workspace_id, owner_user_id) AND (proposed_by_actor_kind =
CASE
    WHEN (lore.current_agent_id() IS NULL) THEN 'human'::text
    ELSE 'agent'::text
END) AND (NOT (proposed_by_agent_id IS DISTINCT FROM lore.current_agent_id())) AND (status = 'pending'::public.memory_proposal_status)));
CREATE POLICY memory_proposals_select ON public.memory_proposals FOR SELECT USING ((lore.can_read_memory_proposal(workspace_id, owner_user_id) AND (expires_at > now())));
CREATE POLICY memory_proposals_update ON public.memory_proposals FOR UPDATE USING (lore.can_review_memory_proposal(workspace_id, owner_user_id)) WITH CHECK (lore.can_review_memory_proposal(workspace_id, owner_user_id));
ALTER TABLE public.observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY observations_select ON public.observations FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.episodes episode
  WHERE ((episode.id = observations.episode_id) AND (episode.workspace_id = observations.workspace_id)))));
ALTER TABLE public.request_idempotency_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY request_idempotency_records_all ON public.request_idempotency_records TO lore_app USING (((workspace_id = lore.current_workspace_id()) AND (actor_user_id = lore.current_user_id()) AND (actor_kind =
CASE
    WHEN (lore.current_agent_id() IS NULL) THEN 'user'::text
    ELSE 'agent'::text
END) AND (actor_id = COALESCE(lore.current_agent_id(), lore.current_user_id())))) WITH CHECK (((workspace_id = lore.current_workspace_id()) AND (actor_user_id = lore.current_user_id()) AND (actor_kind =
CASE
    WHEN (lore.current_agent_id() IS NULL) THEN 'user'::text
    ELSE 'agent'::text
END) AND (actor_id = COALESCE(lore.current_agent_id(), lore.current_user_id()))));
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select ON public.users FOR SELECT USING (lore.can_read_user(id));
ALTER TABLE public.workspace_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_imports_all ON public.workspace_imports TO lore_app USING (((workspace_id = lore.current_workspace_id()) AND (imported_by_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL) AND lore.is_active_member(workspace_id))) WITH CHECK (((workspace_id = lore.current_workspace_id()) AND (imported_by_user_id = lore.current_user_id()) AND (lore.current_agent_id() IS NULL) AND lore.is_active_member(workspace_id)));
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspaces_select ON public.workspaces FOR SELECT USING (((id = lore.current_workspace_id()) AND lore.is_active_member(id)));
GRANT USAGE ON SCHEMA lore TO lore_app;
GRANT USAGE ON SCHEMA lore TO lore_maintenance;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lore FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  lore.agent_has_access(uuid, public.agent_grant_permission),
  lore.agent_owned_by_current_user(uuid),
  lore.authenticate_agent_credential(text, uuid),
  lore.can_append_memory_proposal_evidence(uuid, uuid),
  lore.can_manage_evaluations(uuid, uuid),
  lore.can_manage_workspace(uuid),
  lore.can_read_memory(uuid, uuid, public.memory_scope),
  lore.can_read_memory_proposal(uuid, uuid),
  lore.can_read_user(uuid),
  lore.can_review_memory_proposal(uuid, uuid),
  lore.can_write_memory(uuid, uuid),
  lore.create_workspace(uuid, text),
  lore.current_agent_id(),
  lore.current_request_id(),
  lore.current_user_id(),
  lore.current_workspace_id(),
  lore.ensure_embedding_generation(text, text, integer, text),
  lore.extract_entity_aliases(text),
  lore.is_active_member(uuid),
  lore.list_workspaces(),
  lore.lock_reviewable_proposal_observations(uuid, uuid),
  lore.portable_core_capabilities(),
  lore.protect_memory_identity(),
  lore.protect_memory_link_identity(),
  lore.record_episode(uuid, uuid, text, uuid, public.episode_kind, public.memory_scope, timestamp with time zone, timestamp with time zone, json),
  lore.register_identity(uuid, uuid, text, text, text, text),
  lore.resolve_identity(text, text),
  lore.submit_memory_proposal(uuid, uuid, text, uuid, public.memory_proposal_kind, uuid, integer, text, public.memory_scope, jsonb, boolean, boolean, boolean)
TO lore_app;
GRANT EXECUTE ON FUNCTION
  lore.activate_embedding_generation(text, text, text),
  lore.can_maintain_embedding(uuid, uuid, uuid),
  lore.can_maintain_memory(uuid, uuid),
  lore.claim_memory_embedding_job(uuid, text, text, text, uuid, integer),
  lore.current_maintenance_generation_id(),
  lore.current_maintenance_job_id(),
  lore.current_maintenance_lease_token(),
  lore.embedding_generation_report(text, text, text),
  lore.enqueue_stale_memory_embedding_jobs(text, text, text, integer),
  lore.ensure_embedding_generation(text, text, integer, text),
  lore.finish_memory_embedding_job(uuid, uuid, text, integer),
  lore.list_pending_memory_embedding_jobs(text, text, text, integer, integer),
  lore.lock_current_maintenance_memory(),
  lore.portable_core_capabilities(),
  lore.prune_retiring_embedding_generations(integer),
  lore.purge_expired_portable_core_records()
TO lore_maintenance;
GRANT INSERT, DELETE, UPDATE ON TABLE public.agent_credentials TO lore_app;
GRANT SELECT (id, agent_id, secret_prefix, created_at, last_used_at, revoked_at)
  ON TABLE public.agent_credentials TO lore_app;
GRANT SELECT (id, user_id, provider, subject, email, created_at, updated_at)
  ON TABLE public.identities TO lore_app;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE
  public.agent_workspace_grants,
  public.agents,
  public.evaluation_cases,
  public.evaluation_results,
  public.evaluation_runs,
  public.evaluation_suites,
  public.memberships,
  public.memories,
  public.memory_chunks,
  public.memory_links
TO lore_app;
GRANT SELECT ON TABLE
  public.embedding_generations,
  public.memory_events,
  public.observations,
  public.users,
  public.workspaces
TO lore_app;
GRANT SELECT, INSERT ON TABLE
  public.memory_import_provenance,
  public.memory_proposal_evidence,
  public.memory_proposal_observation_evidence
TO lore_app;
GRANT SELECT, DELETE ON TABLE public.episodes TO lore_app;
GRANT SELECT, DELETE ON TABLE public.memory_chunk_embeddings TO lore_app;
GRANT INSERT ON TABLE public.memory_embedding_jobs TO lore_app;
GRANT SELECT, UPDATE ON TABLE public.memory_proposals TO lore_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.request_idempotency_records TO lore_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.workspace_imports TO lore_app;
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE public.memory_chunk_embeddings TO lore_maintenance;
GRANT SELECT, UPDATE ON TABLE public.memory_chunks TO lore_maintenance;
SET check_function_bodies = true;
-- migrate:down
