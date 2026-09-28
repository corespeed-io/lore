-- migrate:up
-- Schema revision 7: replay records name their subjects in columns, the first of
-- the two releases that move the replay scrub off JSON paths.
--
-- Hard-deleting a Memory, Proposal, or Episode must delete every stored replay
-- body that carries its content. The baseline triggers find those bodies by JSON
-- path (`{memory,id}`, `{proposal,id}`, `{proposal,targetMemoryId}`,
-- `{proposal,acceptedMemoryId}`, `{episode,id}`), so renaming a key in a replayed
-- response would silently stop the scrub. This migration adds one column per path,
-- fills it for the ledger's existing rows, and adds a trigger per table that scrubs
-- by column. The application writes the columns from here on.
--
-- The JSON-path triggers and their 0005 indexes stay for now: during a rolling
-- deploy, app instances older than this release still write replay rows without
-- the columns, and only the JSON paths find those. The second release, once every
-- instance writes the columns and the 24-hour ledger has turned over, drops the
-- JSON-path scrub and its indexes. 0008 indexes the new columns without blocking
-- writes.
--
-- ADD COLUMN takes ACCESS EXCLUSIVE on the ledger until commit, and each CREATE
-- TRIGGER takes SHARE ROW EXCLUSIVE on its table; both are brief here, but under
-- load they queue behind open transactions, so fail fast and let the deploy retry.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.request_idempotency_records
  ADD COLUMN subject_memory_id uuid,
  ADD COLUMN subject_proposal_id uuid,
  ADD COLUMN proposal_target_memory_id uuid,
  ADD COLUMN proposal_accepted_memory_id uuid,
  ADD COLUMN subject_episode_id uuid;

COMMENT ON COLUMN public.request_idempotency_records.subject_memory_id IS
  'The Memory a replayed Memory response carries; forgetting it deletes this row.';
COMMENT ON COLUMN public.request_idempotency_records.subject_proposal_id IS
  'The Proposal a replayed Proposal response carries; deleting it deletes this row.';
COMMENT ON COLUMN public.request_idempotency_records.proposal_target_memory_id IS
  'The target Memory of a replayed update Proposal; forgetting it deletes this row.';
COMMENT ON COLUMN public.request_idempotency_records.proposal_accepted_memory_id IS
  'The Memory an accepted Proposal created or updated; forgetting it deletes this row.';
COMMENT ON COLUMN public.request_idempotency_records.subject_episode_id IS
  'The Episode a replayed Episode response carries; forgetting it deletes this row.';

-- Only ids the application wrote can appear here, but a value that is not a UUID
-- would abort the migration, so the backfill casts only well-formed ones.
UPDATE public.request_idempotency_records replay
SET subject_memory_id = CASE
      WHEN replay.response_body #>> '{memory,id}' ~ '^[0-9a-fA-F-]{36}$'
      THEN (replay.response_body #>> '{memory,id}')::uuid
    END,
    subject_proposal_id = CASE
      WHEN replay.response_body #>> '{proposal,id}' ~ '^[0-9a-fA-F-]{36}$'
      THEN (replay.response_body #>> '{proposal,id}')::uuid
    END,
    proposal_target_memory_id = CASE
      WHEN replay.response_body #>> '{proposal,targetMemoryId}' ~ '^[0-9a-fA-F-]{36}$'
      THEN (replay.response_body #>> '{proposal,targetMemoryId}')::uuid
    END,
    proposal_accepted_memory_id = CASE
      WHEN replay.response_body #>> '{proposal,acceptedMemoryId}' ~ '^[0-9a-fA-F-]{36}$'
      THEN (replay.response_body #>> '{proposal,acceptedMemoryId}')::uuid
    END,
    subject_episode_id = CASE
      WHEN replay.response_body #>> '{episode,id}' ~ '^[0-9a-fA-F-]{36}$'
      THEN (replay.response_body #>> '{episode,id}')::uuid
    END
WHERE replay.response_body IS NOT NULL;

CREATE FUNCTION lore.scrub_replays_of_deleted_memory() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  DELETE FROM public.request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id
    AND (
      replay.subject_memory_id = OLD.id
      OR replay.proposal_target_memory_id = OLD.id
      OR replay.proposal_accepted_memory_id = OLD.id
    );
  RETURN OLD;
END
$$;

CREATE FUNCTION lore.scrub_replays_of_deleted_proposal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  DELETE FROM public.request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id
    AND replay.subject_proposal_id = OLD.id;
  RETURN OLD;
END
$$;

CREATE FUNCTION lore.scrub_replays_of_deleted_episode() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  DELETE FROM public.request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id
    AND replay.subject_episode_id = OLD.id;
  RETURN OLD;
END
$$;

REVOKE ALL ON FUNCTION lore.scrub_replays_of_deleted_memory() FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.scrub_replays_of_deleted_proposal() FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.scrub_replays_of_deleted_episode() FROM PUBLIC;

-- Deleting a Memory also deletes its Proposals (memories_remove_proposals_before_delete),
-- whose own trigger then scrubs by subject_proposal_id.
CREATE TRIGGER memories_scrub_replay_subjects BEFORE DELETE ON public.memories
  FOR EACH ROW EXECUTE FUNCTION lore.scrub_replays_of_deleted_memory();
CREATE TRIGGER memory_proposals_scrub_replay_subjects AFTER DELETE ON public.memory_proposals
  FOR EACH ROW EXECUTE FUNCTION lore.scrub_replays_of_deleted_proposal();
CREATE TRIGGER episodes_scrub_replay_subjects AFTER DELETE ON public.episodes
  FOR EACH ROW EXECUTE FUNCTION lore.scrub_replays_of_deleted_episode();

UPDATE public.lore_system_state
SET schema_revision = 7, updated_at = now()
WHERE singleton;
-- migrate:down
