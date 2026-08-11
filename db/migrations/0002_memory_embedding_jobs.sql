-- migrate:up

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lore_maintenance') THEN
    CREATE ROLE lore_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

CREATE TYPE memory_embedding_job_status AS ENUM (
  'pending',
  'processing',
  'succeeded',
  'dead',
  'cancelled'
);

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

CREATE INDEX memory_embedding_jobs_terminal_completed_idx
  ON memory_embedding_jobs (completed_at)
  WHERE status IN ('succeeded', 'dead', 'cancelled');

CREATE FUNCTION lore.current_maintenance_job_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('lore.maintenance_job_id', true), '')::uuid
$$;

CREATE FUNCTION lore.current_maintenance_lease_token()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('lore.maintenance_lease_token', true), '')::uuid
$$;

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

ALTER TABLE memory_embedding_jobs ENABLE ROW LEVEL SECURITY;

-- The initial policies predate the maintenance role and default to PUBLIC.
-- Scope them to the request role so granting the worker UPDATE cannot make the
-- actor-context policy execute for a maintenance transaction.
ALTER POLICY memory_chunks_select ON memory_chunks TO lore_app;
ALTER POLICY memory_chunks_insert ON memory_chunks TO lore_app;
ALTER POLICY memory_chunks_update ON memory_chunks TO lore_app;
ALTER POLICY memory_chunks_delete ON memory_chunks TO lore_app;

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

CREATE POLICY memory_chunks_maintenance_select ON memory_chunks
  FOR SELECT
  TO lore_maintenance
  USING (lore.can_maintain_memory(workspace_id, memory_id));

CREATE POLICY memory_chunks_maintenance_update ON memory_chunks
  FOR UPDATE
  TO lore_maintenance
  USING (lore.can_maintain_memory(workspace_id, memory_id))
  WITH CHECK (lore.can_maintain_memory(workspace_id, memory_id));

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lore FROM PUBLIC;

GRANT USAGE ON SCHEMA lore TO lore_maintenance;
GRANT SELECT, UPDATE ON memory_chunks TO lore_maintenance;
GRANT INSERT ON memory_embedding_jobs TO lore_app;
GRANT EXECUTE ON FUNCTION lore.current_maintenance_job_id() TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.current_maintenance_lease_token() TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.can_maintain_memory(uuid, uuid) TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.claim_memory_embedding_job(uuid, text, text, text, uuid, integer)
  TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.finish_memory_embedding_job(uuid, uuid, text, integer)
  TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.enqueue_stale_memory_embedding_jobs(text, text, text, integer)
  TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.list_pending_memory_embedding_jobs(text, text, text, integer, integer)
  TO lore_maintenance;

-- migrate:down
