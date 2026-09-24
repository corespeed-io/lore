-- migrate:up
-- Schema revision 4: Code Index job lifecycle, Agent provenance on Code
-- Evidence, per-revision Code Index activation, a one-time cleanup of Code Index
-- jobs and revisions that could never finish, an operator path for dead
-- embedding jobs, and a once-per-statement Workspace read check in the Memory
-- read policies. Every change is forward-only.
SET LOCAL lock_timeout = '5s';

-- One-time cleanup of Code Index state that the code shipping with this revision
-- can never finish.
-- It runs first, before the Memory read policies below take ACCESS EXCLUSIVE on
-- memories, memory_chunks, memory_chunk_embeddings, and memory_links: its scan of
-- code_revision_files must not extend how long Memory traffic is blocked.
--
-- A worker claims only jobs of its own CODE_INDEX_REVISION, so an unfinished job
-- of a retired indexer revision would stay pending, or leased, forever. Cancel it
-- with a content-free reason; enqueueing the commit again creates a job for the
-- current revision. A processing job is cancelled only once its lease is past the
-- one-hour maximum any claim can take, so a worker of the older revision that is
-- still running through a rolling deploy finishes its job. The caller names the
-- retired revisions: the maintenance sweep passes SUPERSEDED_CODE_INDEX_REVISIONS,
-- so jobs that app instances of an older revision enqueue during a deploy are
-- cancelled, while an old worker still sweeping during a later rollout never
-- cancels jobs of the newer revision it does not know.
CREATE FUNCTION lore.cancel_superseded_code_index_jobs(superseded_indexer_revisions text[]) RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  WITH cancelled AS (
    UPDATE code_index_jobs job
    SET status = 'cancelled', lease_token = NULL, leased_at = NULL,
        completed_at = now(), updated_at = now(),
        last_error = 'Superseded by a newer Code Index revision'
    WHERE job.indexer_revision = ANY (superseded_indexer_revisions)
      AND (
        job.status = 'pending'
        OR (job.status = 'processing' AND job.leased_at <= now() - interval '1 hour')
      )
    RETURNING 1
  )
  SELECT count(*)::integer FROM cancelled
$$;
-- Every revision other than v7 is older than this migration, so all of them are
-- retired here. The literal must equal CODE_INDEX_REVISION in
-- src/modules/code/indexing/protocol.ts at the time 0004 ships. It stays fixed
-- afterwards, because an applied migration is frozen.
SELECT lore.cancel_superseded_code_index_jobs(ARRAY(
  SELECT DISTINCT indexer_revision FROM public.code_index_jobs
  WHERE indexer_revision <> 'ast-grep-0.45.3-web-structural-graph-v7-exact-root-partition'
));

-- Before indexer revision v7, a blob holding only a UTF-8 byte-order mark (the
-- three bytes EF BB BF) decoded to no text but was recorded as an indexed
-- manifest entry. No parser can produce an Artifact for it, so the revision's
-- generation could never become ready. Current code excludes such a blob as
-- `empty`, so its manifest and source digests now disagree with the immutable
-- revision row, and every later index of that commit fails as an OID/content
-- conflict. Delete exactly the revisions that hold such an entry, have no ready,
-- active, or retiring generation, and are cited by no Memory or Proposal Code
-- Evidence; indexing the commit again then records it afresh.
-- The delete cannot fail or orphan a row: code_revision_files and
-- code_index_generations cascade from the revision, code_artifacts from the
-- generation, and code_dependency_edges from both of their Artifacts. The
-- Artifact delete trigger then prunes payloads and Symbol/Dependency Sets that no
-- remaining Artifact references (their payload rows cascade from the sets). No
-- other table references these rows by foreign key, no trigger on them rejects a
-- delete, and Code Evidence anchors carry no foreign key to Code Index rows.
DELETE FROM public.code_revisions revision
WHERE EXISTS (
    SELECT 1
    FROM public.code_revision_files file
    WHERE file.revision_id = revision.id
      AND file.index_status = 'indexed'
      AND file.byte_size = 3
      -- SHA-256 of the three bytes EF BB BF.
      AND file.content_sha256 = 'f1945cd6c19e56b3c1c78943ef5ec18116907a4ca1efc40a57d48ab1db7adfc5'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.code_index_generations generation
    WHERE generation.revision_id = revision.id
      AND generation.status IN ('ready', 'active', 'retiring')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.memory_code_evidence evidence
    WHERE evidence.cited_revision_id = revision.id
       OR evidence.validated_revision_id = revision.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.memory_proposal_code_evidence evidence
    WHERE evidence.cited_revision_id = revision.id
  );

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

-- Whether a Code Index job's requester still holds the authority to run it: an
-- active member for a human request, or an active write-granted Agent whose owner
-- is still an active member. Claim and re-enqueue both decide with this one
-- predicate. It runs only inside their SECURITY DEFINER bodies (as the owner, so
-- RLS never hides a row) and is not executable by application roles, because it
-- would otherwise reveal Membership and grant state for arbitrary identifiers.
CREATE FUNCTION lore.code_index_requester_can_run(target_workspace_id uuid, requester_user_id uuid, requester_agent_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT CASE
    WHEN requester_agent_id IS NULL THEN EXISTS (
      SELECT 1 FROM memberships membership
      WHERE membership.workspace_id = target_workspace_id
        AND membership.user_id = requester_user_id
        AND membership.status = 'active'
    )
    ELSE EXISTS (
      SELECT 1
      FROM agents agent
      JOIN agent_workspace_grants grant_row
        ON grant_row.agent_id = agent.id
       AND grant_row.workspace_id = target_workspace_id
      JOIN memberships owner_membership
        ON owner_membership.workspace_id = target_workspace_id
       AND owner_membership.user_id = agent.owner_user_id
      WHERE agent.id = requester_agent_id
        AND agent.owner_user_id = requester_user_id
        AND agent.status = 'active'
        AND grant_row.status = 'active'
        AND grant_row.permission = 'write'
        AND owner_membership.status = 'active'
    )
  END
$$;
REVOKE ALL ON FUNCTION lore.code_index_requester_can_run(uuid, uuid, uuid) FROM PUBLIC;
-- claim_code_index_job is replaced below with CREATE OR REPLACE, so it keeps the
-- owner that created it in 0001, which may not be the role applying 0004. Its body
-- runs as that owner, so grant the helper to it explicitly.
DO $$
DECLARE
  claim_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(function.proowner) INTO claim_owner
  FROM pg_catalog.pg_proc function
  WHERE function.oid = 'lore.claim_code_index_job(uuid,text,uuid,integer)'::regprocedure;
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION lore.code_index_requester_can_run(uuid, uuid, uuid) TO %I',
    claim_owner
  );
END
$$;

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
      AND lore.code_index_requester_can_run(
        job.workspace_id, job.requested_by_user_id, job.requested_by_agent_id
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
-- lock: a cancelled job at once, and a dead job once it has been dead for the
-- re-arm cooldown. It also takes over a job whose requester can no longer be
-- claimed (a revoked grant, a disabled Agent, or a suspended Membership), which
-- would otherwise stay pending forever. A job that can still run, or a dead job
-- inside its cooldown, is left untouched. The requester is always the current
-- Actor, never a caller-supplied identity.
CREATE FUNCTION lore.enqueue_code_index_job(target_repository_id uuid, target_repository_path text, target_commit_oid text, target_source_ref text, target_indexer_revision text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  -- A dead job has spent its whole retry budget with backoff (or failed a
  -- deterministic check), so re-arming it on every request would let any
  -- write-authorized Actor restart a full run of Git reads and parsing in a loop.
  -- Re-enqueue re-arms it only once it has been dead this long.
  dead_job_rearm_cooldown CONSTANT interval := interval '15 minutes';
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
  -- The same authority claim_code_index_job requires, so re-arm and claim can
  -- never disagree about whether a job's requester may still run it.
  requester_can_run := lore.code_index_requester_can_run(
    existing_job.workspace_id, existing_job.requested_by_user_id,
    existing_job.requested_by_agent_id
  );
  -- A processing lease is honoured for the one-hour maximum lease any claim can
  -- request, so an orphaned job is never taken from a worker still inside it.
  IF existing_job.status = 'cancelled'
    OR (
      existing_job.status = 'dead'
      AND existing_job.completed_at <= now() - dead_job_rearm_cooldown
    )
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
COMMENT ON FUNCTION lore.enqueue_code_index_job(uuid, text, text, text, text) IS 'Queues one exact Code Revision for the current Actor, re-arming a cancelled job, a dead job past its 15-minute cooldown, or an orphaned job with the same key.';

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

-- The Memory, chunk, embedding, and link SELECT policies inlined
-- can_read_memory(row.workspace_id, ...), which calls the SECURITY DEFINER
-- is_active_member (or agent_has_access) with a row column, so it ran once per
-- row, and twice per chunk through the nested memories policy. Every policy already
-- requires workspace_id = current_workspace_id(), so the membership or grant check
-- depends only on the session and can run once as an InitPlan, the form the Code
-- Index policies use. Semantics are unchanged: shared rows need an active
-- Membership or an active read grant of an active Agent whose owner is an active
-- member; private rows additionally need the owner User (a human or that User's
-- permitted Agent); revoked Memberships and grants deny.
CREATE FUNCTION lore.can_read_workspace(target_workspace_id uuid) RETURNS boolean
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT target_workspace_id = lore.current_workspace_id()
    AND CASE
      WHEN lore.current_agent_id() IS NULL THEN lore.is_active_member(target_workspace_id)
      ELSE lore.agent_has_access(target_workspace_id, 'read')
    END
$$;
COMMENT ON FUNCTION lore.can_read_workspace(uuid) IS 'Workspace read authority of the current Actor; policies call it as (SELECT lore.can_read_workspace(lore.current_workspace_id())) so it is evaluated once per statement.';
ALTER POLICY memories_select ON public.memories USING (
  (workspace_id = lore.current_workspace_id())
  AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
  AND ((scope = 'shared'::public.memory_scope) OR (owner_user_id = lore.current_user_id()))
);
ALTER POLICY memory_chunks_select ON public.memory_chunks USING (
  (workspace_id = lore.current_workspace_id())
  AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
  AND (EXISTS (
    SELECT 1
    FROM public.memories memory
    WHERE memory.id = memory_chunks.memory_id
      AND memory.workspace_id = memory_chunks.workspace_id
      AND ((memory.scope = 'shared'::public.memory_scope) OR (memory.owner_user_id = lore.current_user_id()))
  ))
);
ALTER POLICY memory_chunk_embeddings_select ON public.memory_chunk_embeddings USING (
  (workspace_id = lore.current_workspace_id())
  AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
  AND (EXISTS (
    SELECT 1
    FROM public.embedding_generations generation
    JOIN public.memories memory
      ON memory.workspace_id = memory_chunk_embeddings.workspace_id
     AND memory.id = memory_chunk_embeddings.memory_id
    WHERE generation.id = memory_chunk_embeddings.generation_id
      AND generation.status = ANY (ARRAY['active'::public.embedding_generation_status, 'retiring'::public.embedding_generation_status])
      AND ((memory.scope = 'shared'::public.memory_scope) OR (memory.owner_user_id = lore.current_user_id()))
  ))
);
ALTER POLICY memory_links_select ON public.memory_links USING (
  (workspace_id = lore.current_workspace_id())
  AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
  AND (EXISTS (
    SELECT 1
    FROM public.memories source
    JOIN public.memories target ON target.workspace_id = source.workspace_id
    WHERE source.workspace_id = memory_links.workspace_id
      AND source.id = memory_links.source_memory_id
      AND target.id = memory_links.target_memory_id
      AND ((source.scope = 'shared'::public.memory_scope) OR (source.owner_user_id = lore.current_user_id()))
      AND ((target.scope = 'shared'::public.memory_scope) OR (target.owner_user_id = lore.current_user_id()))
  ))
);

REVOKE ALL ON FUNCTION
  lore.can_read_workspace(uuid),
  lore.fail_code_index_job(uuid, uuid, text),
  lore.enqueue_code_index_job(uuid, text, text, text, text),
  lore.cancel_agent_code_index_jobs(),
  lore.requeue_dead_memory_embedding_jobs(uuid, boolean),
  lore.cancel_superseded_code_index_jobs(text[])
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  lore.can_read_workspace(uuid),
  lore.enqueue_code_index_job(uuid, text, text, text, text)
TO lore_app;
GRANT EXECUTE ON FUNCTION
  lore.fail_code_index_job(uuid, uuid, text),
  lore.requeue_dead_memory_embedding_jobs(uuid, boolean),
  lore.cancel_superseded_code_index_jobs(text[])
TO lore_maintenance;

UPDATE public.lore_system_state
SET schema_revision = 4, updated_at = now()
WHERE singleton;
-- migrate:down
