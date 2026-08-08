CREATE TYPE embedding_generation_status AS ENUM (
  'building',
  'active',
  'retiring',
  'failed'
);

CREATE TABLE lore_system_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  deployment_id uuid NOT NULL DEFAULT gen_random_uuid(),
  schema_revision integer NOT NULL CHECK (schema_revision > 0),
  api_version text NOT NULL CHECK (btrim(api_version) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO lore_system_state (schema_revision, api_version)
VALUES (3, 'v1');

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

CREATE INDEX request_idempotency_records_expiry_idx
  ON request_idempotency_records (expires_at);

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

CREATE INDEX memory_events_workspace_sequence_idx
  ON memory_events (workspace_id, sequence);
CREATE INDEX memory_events_expiry_idx ON memory_events (expires_at);

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

CREATE UNIQUE INDEX embedding_generations_one_active_idx
  ON embedding_generations ((status))
  WHERE status = 'active';

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

CREATE INDEX memory_chunk_embeddings_workspace_memory_idx
  ON memory_chunk_embeddings (workspace_id, memory_id, generation_id);
CREATE INDEX memory_chunk_embeddings_cosine_idx
  ON memory_chunk_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

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

ALTER TABLE memory_embedding_jobs
  ADD COLUMN generation_id uuid REFERENCES embedding_generations(id);

UPDATE memory_embedding_jobs job
SET generation_id = generation.id
FROM embedding_generations generation
WHERE generation.embedding_provider = job.embedding_provider
  AND generation.embedding_model = job.embedding_model
  AND generation.embedding_revision = job.embedding_revision;

ALTER TABLE memory_embedding_jobs
  ALTER COLUMN generation_id SET NOT NULL;

CREATE INDEX memory_embedding_jobs_generation_status_idx
  ON memory_embedding_jobs (generation_id, status, available_at, created_at, id);

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

CREATE FUNCTION lore.current_request_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('lore.request_id', true), '')::uuid
$$;

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

CREATE TRIGGER memories_append_event_insert_update
AFTER INSERT OR UPDATE ON memories
FOR EACH ROW EXECUTE FUNCTION lore.append_memory_event();

CREATE TRIGGER memories_append_event_delete
BEFORE DELETE ON memories
FOR EACH ROW EXECUTE FUNCTION lore.append_memory_event();

CREATE TRIGGER memory_links_append_event_insert_update
AFTER INSERT OR UPDATE ON memory_links
FOR EACH ROW EXECUTE FUNCTION lore.append_memory_link_event();

CREATE TRIGGER memory_links_append_event_delete
BEFORE DELETE ON memory_links
FOR EACH ROW EXECUTE FUNCTION lore.append_memory_link_event();

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
      job.status IN ('pending', 'processing')
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
    ORDER BY job.id
    LIMIT job_limit
  ) candidate;

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
        AND job.id = ANY(terminal_job_ids || stale_job_ids)
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

  FOREACH target_job_id IN ARRAY terminal_job_ids LOOP
    DELETE FROM memory_embedding_jobs job
    WHERE job.id = target_job_id
      AND (
        (job.status IN ('succeeded', 'cancelled')
          AND job.completed_at < now() - interval '7 days')
        OR (job.status = 'dead' AND job.completed_at < now() - interval '30 days')
      );
  END LOOP;

  FOREACH target_job_id IN ARRAY stale_job_ids LOOP
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
          job.status IN ('pending', 'processing')
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

ALTER TABLE request_idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_chunk_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_import_provenance ENABLE ROW LEVEL SECURITY;

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

CREATE POLICY embedding_generations_select ON embedding_generations
  FOR SELECT
  TO lore_app
  USING (status IN ('active', 'retiring'));

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

CREATE POLICY memory_chunk_embeddings_maintenance_all ON memory_chunk_embeddings
  FOR ALL
  TO lore_maintenance
  USING (lore.can_maintain_embedding(generation_id, workspace_id, memory_id))
  WITH CHECK (lore.can_maintain_embedding(generation_id, workspace_id, memory_id));

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

REVOKE ALL ON FUNCTION lore.current_request_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.append_memory_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.append_memory_link_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.ensure_embedding_generation(text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.current_maintenance_generation_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.lock_current_maintenance_memory() FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.can_maintain_embedding(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.embedding_generation_report(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.activate_embedding_generation(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.purge_expired_portable_core_records() FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.prune_retiring_embedding_generations(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.portable_core_capabilities() FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON request_idempotency_records TO lore_app;
GRANT SELECT ON memory_events TO lore_app;
GRANT SELECT ON embedding_generations TO lore_app;
GRANT SELECT, DELETE ON memory_chunk_embeddings TO lore_app;
GRANT SELECT, INSERT, UPDATE ON workspace_imports TO lore_app;
GRANT SELECT, INSERT ON memory_import_provenance TO lore_app;
GRANT INSERT, UPDATE, DELETE, SELECT ON memory_chunk_embeddings TO lore_maintenance;

GRANT EXECUTE ON FUNCTION lore.current_request_id() TO lore_app;
GRANT EXECUTE ON FUNCTION lore.ensure_embedding_generation(text, text, integer, text)
  TO lore_app, lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.current_maintenance_generation_id() TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.lock_current_maintenance_memory() TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.can_maintain_embedding(uuid, uuid, uuid) TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.embedding_generation_report(text, text, text) TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.activate_embedding_generation(text, text, text) TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.purge_expired_portable_core_records() TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.prune_retiring_embedding_generations(integer)
  TO lore_maintenance;
GRANT EXECUTE ON FUNCTION lore.portable_core_capabilities() TO lore_app, lore_maintenance;

COMMENT ON TABLE request_idempotency_records IS
  'Actor-scoped replay ledger; request payloads are represented only by SHA-256 hashes.';
COMMENT ON TABLE memory_events IS
  'Content-free transactional mutation outbox and bounded deletion tombstones.';
COMMENT ON TABLE memory_chunk_embeddings IS
  'Generation-scoped vectors; incompatible spaces are never searched together.';
