-- migrate:up
-- Schema revision 4: Code Index job lifecycle, Agent provenance on Code
-- Evidence, per-revision Code Index activation, index-backed replay scrubs, and
-- an operator path for dead embedding jobs. Every change is forward-only.
SET LOCAL lock_timeout = '5s';

-- Deleting an Agent runs memory_code_evidence_created_by_agent_id_fkey's
-- ON DELETE SET NULL, which the anchor trigger used to reject, so any Agent that
-- had ever cited Code Evidence could not be deleted. Allow exactly that one
-- transition, as protect_memory_identity does for Memory provenance: a non-null
-- created_by_agent_id may become NULL only once its Agent row is gone. SECURITY
-- DEFINER keeps RLS on agents from hiding a surviving row, which would otherwise
-- let a caller clear provenance while the Agent still exists.
CREATE OR REPLACE FUNCTION lore.protect_memory_code_evidence_anchor() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF (NEW.id, NEW.workspace_id, NEW.memory_id, NEW.repository_id,
      NEW.cited_revision_id, NEW.cited_generation_id, NEW.cited_artifact_id,
      NEW.cited_commit_oid, NEW.relationship, NEW.cited_path, NEW.cited_symbol_key,
      NEW.cited_declaration_key, NEW.cited_declaration_chunk_ordinal,
      NEW.cited_declaration_context_sha256,
      NEW.cited_content_sha256,
      NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.workspace_id, OLD.memory_id, OLD.repository_id,
      OLD.cited_revision_id, OLD.cited_generation_id, OLD.cited_artifact_id,
      OLD.cited_commit_oid, OLD.relationship, OLD.cited_path, OLD.cited_symbol_key,
      OLD.cited_declaration_key, OLD.cited_declaration_chunk_ordinal,
      OLD.cited_declaration_context_sha256,
      OLD.cited_content_sha256,
      OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Memory Code Evidence anchors are immutable';
  END IF;
  IF NEW.created_by_agent_id IS DISTINCT FROM OLD.created_by_agent_id THEN
    IF OLD.created_by_agent_id IS NOT NULL
      AND NEW.created_by_agent_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.agents
        WHERE id = OLD.created_by_agent_id
      ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Memory Code Evidence anchors are immutable';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION lore.protect_memory_code_evidence_anchor() IS 'Keeps Memory Code Evidence anchors immutable while allowing an Agent foreign-key deletion to clear its provenance reference.';

-- A worker that dies during a job's final attempt leaves an expired lease that no
-- claim can take, because attempt_count has already reached max_attempts. Retire
-- such leases as dead, mirroring claim_memory_embedding_job, so the job reaches a
-- terminal state that operators can see and re-enqueue can re-arm.
CREATE OR REPLACE FUNCTION lore.claim_code_index_job(requested_job_id uuid, requested_indexer_revision text, new_lease_token uuid, lease_timeout_seconds integer) RETURNS TABLE(id uuid, workspace_id uuid, repository_id uuid, repository_key text, display_name text, repository_path text, commit_oid text, source_ref text, indexer_revision text, requested_by_user_id uuid, requested_by_agent_id uuid, attempt_count smallint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF lease_timeout_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'Lease timeout must be between 30 and 3600 seconds';
  END IF;
  UPDATE code_index_jobs job
  SET status = 'dead', lease_token = NULL, leased_at = NULL,
      last_error = 'Code Index job lease expired during its final attempt',
      completed_at = now(), updated_at = now()
  WHERE job.status = 'processing'
    AND job.indexer_revision = requested_indexer_revision
    AND (requested_job_id IS NULL OR job.id = requested_job_id)
    AND job.attempt_count >= job.max_attempts
    AND job.leased_at < now() - make_interval(secs => lease_timeout_seconds);
  RETURN QUERY
  WITH candidate AS (
    SELECT job.id
    FROM code_index_jobs job
    WHERE job.indexer_revision = requested_indexer_revision
      AND (requested_job_id IS NULL OR job.id = requested_job_id)
      AND job.attempt_count < job.max_attempts
      AND (
        (job.status = 'pending' AND job.available_at <= now())
        OR (job.status = 'processing' AND job.leased_at < now() - make_interval(secs => lease_timeout_seconds))
      )
      AND (
        (job.requested_by_agent_id IS NULL AND EXISTS (
          SELECT 1 FROM memberships membership
          WHERE membership.workspace_id = job.workspace_id
            AND membership.user_id = job.requested_by_user_id
            AND membership.status = 'active'
        ))
        OR (job.requested_by_agent_id IS NOT NULL AND EXISTS (
          SELECT 1
          FROM agents agent
          JOIN agent_workspace_grants grant_row
            ON grant_row.agent_id = agent.id
           AND grant_row.workspace_id = job.workspace_id
          JOIN memberships owner_membership
            ON owner_membership.workspace_id = job.workspace_id
           AND owner_membership.user_id = agent.owner_user_id
          WHERE agent.id = job.requested_by_agent_id
            AND agent.owner_user_id = job.requested_by_user_id
            AND agent.status = 'active'
            AND grant_row.status = 'active'
            AND grant_row.permission = 'write'
            AND owner_membership.status = 'active'
        ))
      )
    ORDER BY job.available_at, job.created_at, job.id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE code_index_jobs job
    SET status = 'processing', attempt_count = job.attempt_count + 1,
        lease_token = new_lease_token, leased_at = now(), updated_at = now(),
        completed_at = NULL
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.*
  )
  SELECT claimed.id, claimed.workspace_id, claimed.repository_id,
         repository.repository_key, repository.display_name,
         claimed.repository_path, claimed.commit_oid, claimed.source_ref,
         claimed.indexer_revision, claimed.requested_by_user_id,
         claimed.requested_by_agent_id, claimed.attempt_count
  FROM claimed
  JOIN code_repositories repository
    ON repository.workspace_id = claimed.workspace_id
   AND repository.id = claimed.repository_id;
END
$$;

-- A deterministic failure (invalid input, an OID/content conflict, or an
-- incomplete generation) fails identically on every retry, so the worker ends
-- the job at once instead of spending its remaining attempts. finish_code_index_job
-- keeps the retry/backoff path for transient failures.
CREATE FUNCTION lore.fail_code_index_job(target_job_id uuid, target_lease_token uuid, failure_detail text) RETURNS public.code_index_job_status
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  final_status public.code_index_job_status;
BEGIN
  IF failure_detail IS NULL OR btrim(failure_detail) = '' THEN
    RAISE EXCEPTION 'A terminal Code Index failure requires a failure detail';
  END IF;
  UPDATE code_index_jobs job
  SET status = 'dead', lease_token = NULL, leased_at = NULL,
      completed_at = now(), last_error = left(failure_detail, 1000), updated_at = now()
  WHERE job.id = target_job_id
    AND job.lease_token = target_lease_token
    AND job.status = 'processing'
  RETURNING job.status INTO final_status;
  RETURN final_status;
END
$$;
COMMENT ON FUNCTION lore.fail_code_index_job(uuid, uuid, text) IS 'Ends one leased Code Index job as dead without further retries; the caller supplies a content-free failure detail.';

-- The job key (repository, commit, indexer revision) is unique, so a dead or
-- cancelled job used to block that commit forever: enqueue was INSERT ... ON
-- CONFLICT DO NOTHING, and lore_app has no UPDATE on code_index_jobs. Re-enqueue
-- now re-arms the existing row for the new requester, atomically under its row
-- lock. It also takes over a job whose requester can no longer be claimed (a
-- revoked grant, a disabled Agent, or a suspended Membership), which would
-- otherwise stay pending forever. A job that can still run is left untouched.
-- The requester is always the current Actor, never a caller-supplied identity.
CREATE FUNCTION lore.enqueue_code_index_job(target_repository_id uuid, target_repository_path text, target_commit_oid text, target_source_ref text, target_indexer_revision text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  target_workspace_id uuid := lore.current_workspace_id();
  inserted_job_id uuid;
  existing_job public.code_index_jobs%ROWTYPE;
  requester_can_run boolean;
BEGIN
  IF target_workspace_id IS NULL OR NOT lore.can_write_code_index(target_workspace_id) THEN
    RAISE EXCEPTION 'Actor cannot queue code in this Workspace'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM code_repositories repository
    WHERE repository.workspace_id = target_workspace_id
      AND repository.id = target_repository_id
  ) THEN
    RAISE EXCEPTION 'Repository is not visible to this Actor'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO code_index_jobs (
    id, workspace_id, repository_id, repository_path, commit_oid,
    source_ref, indexer_revision, requested_by_user_id, requested_by_agent_id
  ) VALUES (
    gen_random_uuid(), target_workspace_id, target_repository_id, target_repository_path,
    target_commit_oid, target_source_ref, target_indexer_revision,
    lore.current_user_id(), lore.current_agent_id()
  )
  ON CONFLICT (repository_id, commit_oid, indexer_revision) DO NOTHING
  RETURNING code_index_jobs.id INTO inserted_job_id;
  IF inserted_job_id IS NOT NULL THEN
    RETURN inserted_job_id;
  END IF;
  SELECT job.* INTO existing_job
  FROM code_index_jobs job
  WHERE job.workspace_id = target_workspace_id
    AND job.repository_id = target_repository_id
    AND job.commit_oid = target_commit_oid
    AND job.indexer_revision = target_indexer_revision
  FOR UPDATE;
  IF existing_job.id IS NULL THEN
    RAISE EXCEPTION 'Index job is not visible to this Actor'
      USING ERRCODE = '42501';
  END IF;
  -- Mirrors the requester predicate of claim_code_index_job.
  requester_can_run := CASE
    WHEN existing_job.requested_by_agent_id IS NULL THEN EXISTS (
      SELECT 1 FROM memberships membership
      WHERE membership.workspace_id = existing_job.workspace_id
        AND membership.user_id = existing_job.requested_by_user_id
        AND membership.status = 'active'
    )
    ELSE EXISTS (
      SELECT 1
      FROM agents agent
      JOIN agent_workspace_grants grant_row
        ON grant_row.agent_id = agent.id
       AND grant_row.workspace_id = existing_job.workspace_id
      JOIN memberships owner_membership
        ON owner_membership.workspace_id = existing_job.workspace_id
       AND owner_membership.user_id = agent.owner_user_id
      WHERE agent.id = existing_job.requested_by_agent_id
        AND agent.owner_user_id = existing_job.requested_by_user_id
        AND agent.status = 'active'
        AND grant_row.status = 'active'
        AND grant_row.permission = 'write'
        AND owner_membership.status = 'active'
    )
  END;
  -- A processing lease is honoured for the one-hour maximum lease any claim can
  -- request, so an orphaned job is never taken from a worker still inside it.
  IF existing_job.status IN ('dead', 'cancelled')
    OR (
      NOT requester_can_run
      AND (
        existing_job.status = 'pending'
        OR (existing_job.status = 'processing' AND existing_job.leased_at <= now() - interval '1 hour')
      )
    )
  THEN
    UPDATE code_index_jobs job
    SET status = 'pending', attempt_count = 0, available_at = now(),
        lease_token = NULL, leased_at = NULL, completed_at = NULL, last_error = NULL,
        repository_path = target_repository_path, source_ref = target_source_ref,
        requested_by_user_id = lore.current_user_id(),
        requested_by_agent_id = lore.current_agent_id(),
        updated_at = now()
    WHERE job.id = existing_job.id;
  END IF;
  RETURN existing_job.id;
END
$$;
COMMENT ON FUNCTION lore.enqueue_code_index_job(uuid, text, text, text, text) IS 'Queues one exact Code Revision for the current Actor, re-arming a terminal or orphaned job with the same key.';

-- An Agent's Code Index request carries that Agent's authority. Disabling the
-- Agent left its jobs pending forever (claim skips them), and deleting it then ran
-- requested_by_agent_id's ON DELETE SET NULL, after which claim treated the job as
-- a request by the human owner. Cancel the Agent's unfinished jobs first, on both
-- paths, so they can never run under another authority; re-enqueue re-arms them.
CREATE FUNCTION lore.cancel_agent_code_index_jobs() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  UPDATE code_index_jobs job
  SET status = 'cancelled', lease_token = NULL, leased_at = NULL,
      completed_at = now(), updated_at = now(),
      last_error = CASE TG_OP
        WHEN 'DELETE' THEN 'Requesting Agent was deleted'
        ELSE 'Requesting Agent was disabled'
      END
  WHERE job.requested_by_agent_id = OLD.id
    AND job.status IN ('pending', 'processing');
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
CREATE INDEX code_index_jobs_requested_by_agent_idx ON public.code_index_jobs USING btree (requested_by_agent_id) WHERE (requested_by_agent_id IS NOT NULL);
CREATE TRIGGER agents_cancel_code_index_jobs_on_disable AFTER UPDATE OF status ON public.agents FOR EACH ROW WHEN (NEW.status = 'disabled'::public.agent_status AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION lore.cancel_agent_code_index_jobs();
CREATE TRIGGER agents_cancel_code_index_jobs_before_delete BEFORE DELETE ON public.agents FOR EACH ROW EXECUTE FUNCTION lore.cancel_agent_code_index_jobs();

-- The baseline took LOCK TABLE code_index_generations IN SHARE ROW EXCLUSIVE MODE
-- after the calling transaction already held ROW EXCLUSIVE from
-- ready_code_index_generation, so two jobs finishing at once deadlocked on the
-- upgrade. Serialize publication per exact revision instead. The generation row
-- lock comes first, matching ready -> activate in the maintenance transaction;
-- FOR NO KEY UPDATE on the revision conflicts only with itself, never with the
-- FOR KEY SHARE locks that concurrent foreign-key inserts take. The
-- one-active-per-revision unique index remains the correctness backstop.
CREATE OR REPLACE FUNCTION lore.activate_code_index_generation(target_generation_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  target_workspace_id uuid;
  target_repository_id uuid;
  target_revision_id uuid;
  target_status public.code_index_generation_status;
  expected_artifacts integer;
  actual_artifacts bigint;
  missing_files bigint;
BEGIN
  SELECT generation.workspace_id, generation.repository_id, generation.revision_id, generation.status,
         generation.artifact_count
    INTO target_workspace_id, target_repository_id, target_revision_id, target_status, expected_artifacts
  FROM code_index_generations generation
  WHERE generation.id = target_generation_id
  FOR UPDATE;
  IF target_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Code Index generation does not exist';
  END IF;
  IF NOT lore.can_write_code_index(target_workspace_id)
     AND NOT lore.can_maintain_code_index(target_workspace_id, target_repository_id) THEN
    RAISE EXCEPTION 'Actor cannot activate this Code Index generation'
      USING ERRCODE = '42501';
  END IF;
  IF target_status = 'active' THEN
    RETURN target_generation_id;
  END IF;
  IF target_status NOT IN ('ready', 'retiring') THEN
    RAISE EXCEPTION 'Code Index generation is not ready';
  END IF;
  PERFORM 1
  FROM code_revisions revision
  WHERE revision.id = target_revision_id
  FOR NO KEY UPDATE;
  SELECT count(*) INTO actual_artifacts
  FROM code_artifacts artifact
  WHERE artifact.generation_id = target_generation_id;
  SELECT count(*) INTO missing_files
  FROM code_revision_files file
  WHERE file.revision_id = target_revision_id
    AND file.index_status = 'indexed'
    AND NOT EXISTS (
      SELECT 1
      FROM code_artifacts artifact
      WHERE artifact.generation_id = target_generation_id
        AND artifact.path = file.path
    );
  IF actual_artifacts <> expected_artifacts OR missing_files > 0 THEN
    RAISE EXCEPTION 'Code Index generation is incomplete (expected %, actual %, missing files %)',
      expected_artifacts, actual_artifacts, missing_files;
  END IF;
  UPDATE code_index_generations
  SET status = 'retiring', retired_at = now()
  WHERE revision_id = target_revision_id
    AND status = 'active'
    AND id <> target_generation_id;
  UPDATE code_index_generations
  SET status = 'active', activated_at = COALESCE(activated_at, now()), retired_at = NULL
  WHERE id = target_generation_id;
  RETURN target_generation_id;
END
$$;

-- Hard-deleting a Memory, Proposal, or Episode scrubs replay bodies that mention
-- it. Those triggers compared an unindexed JSON path, so every delete scanned and
-- detoasted the Workspace's whole 24-hour replay ledger. Each partial expression
-- index matches one trigger predicate exactly; the triggers run as their owner,
-- so RLS never keeps the planner off them.
CREATE INDEX request_idempotency_records_memory_id_idx ON public.request_idempotency_records USING btree (workspace_id, ((response_body #>> '{memory,id}'::text[]))) WHERE ((response_body #>> '{memory,id}'::text[]) IS NOT NULL);
CREATE INDEX request_idempotency_records_proposal_id_idx ON public.request_idempotency_records USING btree (workspace_id, ((response_body #>> '{proposal,id}'::text[]))) WHERE ((response_body #>> '{proposal,id}'::text[]) IS NOT NULL);
CREATE INDEX request_idempotency_records_proposal_target_idx ON public.request_idempotency_records USING btree (workspace_id, ((response_body #>> '{proposal,targetMemoryId}'::text[]))) WHERE ((response_body #>> '{proposal,targetMemoryId}'::text[]) IS NOT NULL);
CREATE INDEX request_idempotency_records_proposal_accepted_idx ON public.request_idempotency_records USING btree (workspace_id, ((response_body #>> '{proposal,acceptedMemoryId}'::text[]))) WHERE ((response_body #>> '{proposal,acceptedMemoryId}'::text[]) IS NOT NULL);
CREATE INDEX request_idempotency_records_episode_id_idx ON public.request_idempotency_records USING btree (workspace_id, ((response_body #>> '{episode,id}'::text[]))) WHERE ((response_body #>> '{episode,id}'::text[]) IS NOT NULL);

-- Maintenance writes generation-scoped vectors into memory_chunk_embeddings and
-- never changes canonical chunk rows. The baseline still granted it UPDATE on
-- memory_chunks (including canonical content) behind a lease-scoped policy that no
-- code path uses. The legacy embedding columns stay; nothing writes them here.
DROP POLICY memory_chunks_maintenance_update ON public.memory_chunks;
REVOKE UPDATE ON TABLE public.memory_chunks FROM lore_maintenance;

-- Operators used to re-arm dead embedding jobs with hand-written SQL, one job id
-- at a time. This re-arms every dead job of one explicit generation whose Memory
-- still matches the job's version, owner, and scope; stale jobs stay dead for the
-- sweep to cancel. With apply_requeue false it only counts. The generation lock
-- precedes the job updates, the order retention pruning and activation use.
CREATE FUNCTION lore.requeue_dead_memory_embedding_jobs(target_generation_id uuid, apply_requeue boolean) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  affected bigint;
BEGIN
  PERFORM generation.id
  FROM embedding_generations generation
  WHERE generation.id = target_generation_id
    AND generation.status IN ('building', 'active')
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Embedding generation % is not building or active', target_generation_id;
  END IF;
  IF NOT apply_requeue THEN
    SELECT count(*) INTO affected
    FROM memory_embedding_jobs job
    JOIN memories memory
      ON memory.workspace_id = job.workspace_id
     AND memory.id = job.memory_id
     AND memory.owner_user_id = job.owner_user_id
     AND memory.scope = job.memory_scope
     AND memory.version = job.memory_version
    WHERE job.generation_id = target_generation_id
      AND job.status = 'dead';
    RETURN affected;
  END IF;
  UPDATE memory_embedding_jobs job
  SET status = 'pending', attempt_count = 0, available_at = now(),
      lease_token = NULL, leased_at = NULL, last_error = NULL,
      completed_at = NULL, updated_at = now()
  FROM memories memory
  WHERE job.generation_id = target_generation_id
    AND job.status = 'dead'
    AND memory.workspace_id = job.workspace_id
    AND memory.id = job.memory_id
    AND memory.owner_user_id = job.owner_user_id
    AND memory.scope = job.memory_scope
    AND memory.version = job.memory_version;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$$;
COMMENT ON FUNCTION lore.requeue_dead_memory_embedding_jobs(uuid, boolean) IS 'Counts, or re-arms as pending with a fresh retry budget, the current dead embedding jobs of one building or active generation.';

REVOKE ALL ON FUNCTION
  lore.fail_code_index_job(uuid, uuid, text),
  lore.enqueue_code_index_job(uuid, text, text, text, text),
  lore.cancel_agent_code_index_jobs(),
  lore.requeue_dead_memory_embedding_jobs(uuid, boolean)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.enqueue_code_index_job(uuid, text, text, text, text) TO lore_app;
GRANT EXECUTE ON FUNCTION
  lore.fail_code_index_job(uuid, uuid, text),
  lore.requeue_dead_memory_embedding_jobs(uuid, boolean)
TO lore_maintenance;

UPDATE public.lore_system_state
SET schema_revision = 4, updated_at = now()
WHERE singleton;
-- migrate:down
