-- migrate:up
-- Schema revision 10: embedding claims return only the chunks a generation still
-- lacks, forget records its outbound Link deletions, Agent authentication writes
-- last_used_at at most once a minute, memory_chunks loses its unused embedding
-- columns and request UPDATE path, and lore_system_state records the oldest
-- application revision this schema stays compatible with.
--
-- compatible_from stays 9: an application or worker of revision 9 uses none of the
-- objects removed here. Its worker embeds the chunks a claim returns and writes
-- each by chunk id, so a partial or empty claim still completes.
--
-- It takes ACCESS EXCLUSIVE on memory_chunks, then on lore_system_state at the end,
-- and ACCESS SHARE on embedding_generations when the capabilities body is validated
-- (tests/server/schema-revision-11-upgrade.test.ts asserts the set). memory_chunks
-- goes first: a request write may hold it for its whole transaction, and the 5s
-- timeout below bounds that wait while readiness, which reads lore_system_state
-- with a 2s statement timeout, is not yet blocked. Request writes lock memories
-- before memory_chunks and this migration never locks memories, so it cannot join a
-- lock cycle with them. A timeout fails the migration retryably and records nothing.
SET LOCAL lock_timeout = '5s';

-- Vectors live in memory_chunk_embeddings, one row per generation and chunk. These
-- baseline columns predate generations, and nothing reads or writes them. Dropping
-- them also drops their CHECK (memory_chunks_embedding_state_check) and their HNSW
-- index (memory_chunks_embedding_cosine_idx), which every chunk insert maintained.
-- ACCESS EXCLUSIVE, catalog-only: no rewrite.
ALTER TABLE public.memory_chunks
  DROP COLUMN embedding,
  DROP COLUMN embedding_provider,
  DROP COLUMN embedding_model,
  DROP COLUMN embedding_revision,
  DROP COLUMN embedded_at;

-- Chunks are inserted and deleted, never updated: a content change replaces them.
-- 0004 revoked maintenance UPDATE; this removes the request role's too.
DROP POLICY memory_chunks_update ON public.memory_chunks;
REVOKE UPDATE ON TABLE public.memory_chunks FROM lore_app;

-- A claim returns only the chunks of the job's Memory that have no vector in the
-- job's generation, so a re-queued job embeds what is missing and a job with
-- nothing missing finishes without a provider call. Everything else is the
-- baseline body: stale-version cancellation, lease expiry, ordering, and locks.
CREATE OR REPLACE FUNCTION lore.claim_memory_embedding_job(requested_job_id uuid, active_embedding_provider text, active_embedding_model text, active_embedding_revision text, new_lease_token uuid, lease_timeout_seconds integer) RETURNS TABLE(id uuid, workspace_id uuid, memory_id uuid, owner_user_id uuid, memory_scope public.memory_scope, memory_version integer, attempt_count smallint, chunks jsonb)
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
   AND NOT EXISTS (
     SELECT 1
     FROM memory_chunk_embeddings embedded
     WHERE embedded.generation_id = claimed.generation_id
       AND embedded.chunk_id = chunk.id
   )
  GROUP BY
    claimed.id, claimed.workspace_id, claimed.memory_id, claimed.owner_user_id,
    claimed.memory_scope, claimed.memory_version, claimed.attempt_count;
END
$$;

-- Every forget of a Memory with Links records a memory_link.deleted event for each
-- of its Links. The body is the baseline's, including the JSON-path replay scrub,
-- which stays until the second release described in 0009 removes it.
CREATE OR REPLACE FUNCTION lore.append_memory_event() RETURNS trigger
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
  -- The cascade deletes this Memory's Links after its row is gone, so the Link
  -- trigger finds no source and skips its outbound Links; an inbound Link's source
  -- survives and the Link trigger records it. Record each outbound Link here, with
  -- the columns and expiry the Link trigger gives a deleted Link. Links cannot point
  -- at their own source (memory_links_check), so no Link is recorded twice.
  INSERT INTO memory_events (
    id, workspace_id, owner_user_id, memory_scope,
    resource_type, resource_id, source_memory_id, related_memory_id, event_type,
    actor_user_id, actor_agent_id, request_id, changed_fields,
    expires_at
  )
  SELECT
    gen_random_uuid(), link.workspace_id, OLD.owner_user_id, OLD.scope,
    'memory_link', link.id, link.source_memory_id, link.target_memory_id, 'memory_link.deleted',
    lore.current_user_id(), lore.current_agent_id(), lore.current_request_id(),
    ARRAY['endpoints', 'kind', 'metadata', 'weight'],
    now() + interval '30 days'
  FROM memory_links link
  WHERE link.workspace_id = OLD.workspace_id
    AND link.source_memory_id = OLD.id
  ORDER BY link.created_at, link.id;
  RETURN OLD;
END
$$;

-- Authentication still checks the credential, its revocation, the Agent's status,
-- the Workspace Grant, and the owner's Membership on every call, and returns the
-- Actor whether or not it writes. It writes last_used_at only when it is unset or
-- more than 60 seconds old, and that age is part of the UPDATE's predicate: a CASE
-- in its SET list would still lock and rewrite the row on every request. Under
-- READ COMMITTED, two concurrent calls that both see an old value serialize on the
-- row, and the second re-checks the age against the first one's write and skips.
-- A data-modifying CTE runs to completion even though the result does not read it.
CREATE OR REPLACE FUNCTION lore.authenticate_agent_credential(candidate_secret_hash text, target_workspace_id uuid) RETURNS TABLE(user_id uuid, agent_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  RETURN QUERY
  WITH authenticated AS (
    SELECT
      credential.id AS credential_id,
      agent.owner_user_id AS authenticated_user_id,
      agent.id AS authenticated_agent_id
    FROM agent_credentials credential
    JOIN agents agent ON agent.id = credential.agent_id
    JOIN agent_workspace_grants grant_row ON grant_row.agent_id = agent.id
    JOIN memberships owner_membership
      ON owner_membership.workspace_id = grant_row.workspace_id
     AND owner_membership.user_id = agent.owner_user_id
    WHERE credential.secret_hash = candidate_secret_hash
      AND credential.revoked_at IS NULL
      AND agent.status = 'active'
      AND grant_row.workspace_id = target_workspace_id
      AND grant_row.status = 'active'
      AND owner_membership.status = 'active'
  ), touched AS (
    UPDATE agent_credentials credential
    SET last_used_at = now()
    FROM authenticated
    WHERE credential.id = authenticated.credential_id
      AND (
        credential.last_used_at IS NULL
        OR credential.last_used_at < now() - interval '60 seconds'
      )
  )
  SELECT authenticated.authenticated_user_id, authenticated.authenticated_agent_id
  FROM authenticated;
END
$$;

-- The oldest application revision this schema serves. Readiness accepts an
-- application revision R when compatible_from <= R <= schema_revision, so a rolling
-- deploy keeps older instances ready across a migration that removes nothing they
-- use. Every migration from this one on sets it explicitly in its final UPDATE (a
-- test enforces that); one that removes or changes something an older revision
-- relies on raises it. NULL, which only a database before this revision held,
-- means this revision alone; capabilities publish it as schemaRevision.
ALTER TABLE public.lore_system_state
  ADD COLUMN compatible_from integer,
  ADD CONSTRAINT lore_system_state_compatible_from_check
    CHECK (compatible_from IS NULL OR compatible_from BETWEEN 1 AND schema_revision);

-- Capabilities publish compatibleFrom. The body is 0006's plus that one field, and
-- CREATE OR REPLACE keeps its grants.
CREATE OR REPLACE FUNCTION lore.portable_core_capabilities() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT jsonb_build_object(
    'apiVersion', state.api_version,
    'schemaRevision', state.schema_revision,
    'compatibleFrom', COALESCE(state.compatible_from, state.schema_revision),
    'deploymentId', state.deployment_id,
    'memoryChunking', jsonb_build_object(
      'revision', 'lore-memory-chunking-v2',
      'maximumCharacters', 1200,
      'overlapCharacters', 0
    ),
    'features', jsonb_build_object(
      'idempotency', true,
      'optimisticConcurrency', true,
      'transactionalOutbox', true,
      'workspacePortability', true,
      'embeddingGenerations', true,
      'cursorPagination', true,
      'memoryProposals', true,
      'observationEvidence', true,
      'codeIndex', true,
      'codeDependencies', true,
      'codeEvidence', true,
      'memoryLinks', true
    ),
    'limits', jsonb_build_object(
      'memoryContentRecommendedCharacters', 8000,
      'memoryContentMaximumCharacters', 32000,
      'memoryMaximumChunks', 64,
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
      'observationBatchRead', 50,
      'codeIndexFiles', 20000,
      'codeIndexSourceBytes', 134217728,
      'codeIndexArtifacts', 100000,
      'codeDependencyResults', 200,
      'codeSearchResults', 100,
      'memoryLinkMetadataCharacters', 1000,
      'memoryLinkKindsPerPair', 16,
      'memoryLinksPerSource', 1000,
      'memoryLinksPerTarget', 1000,
      'memoryLinksPerOwner', 50000,
      'memoryLinkList', 100,
      'graphLinks', 40000
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

UPDATE public.lore_system_state
SET schema_revision = 10, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
