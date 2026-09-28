-- migrate:up
-- Schema revision 9: triggers that delete a forgotten subject's replay rows by the
-- subject columns 0007 added and 0008 indexed.
--
-- The three DELETE triggers each delete the replay rows that name their row in a
-- subject column. The baseline JSON-path triggers keep running beside them until the
-- second release, because app instances older than revision 7 write rows without the
-- columns during a rolling deploy, and only the JSON paths find those.
--
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on its table until commit. This locks
-- episodes, then memories, then memory_proposals: the order Agent deletion's
-- foreign keys reach them, and the order forget, Proposal acceptance, and the
-- maintenance sweep reach the last two. It never locks the replay ledger, which every
-- keyed write locks first (its claim) before it writes a Memory, Proposal, or
-- Episode, so it cannot form a cycle with one; the ledger's own trigger is in 0007,
-- where ADD COLUMN already holds that table alone. Under load a
-- lock may still queue behind open transactions, so fail fast and let the deploy
-- retry; this migration rewrites no rows, so a retry repeats nothing costly.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION lore.scrub_replays_of_deleted_memory() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  -- One statement per column, so each matches its own 0008 partial index; an OR
  -- across them plans as a scan of the Workspace's whole ledger.
  DELETE FROM public.request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id AND replay.subject_memory_id = OLD.id;
  DELETE FROM public.request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id AND replay.proposal_target_memory_id = OLD.id;
  DELETE FROM public.request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id AND replay.proposal_accepted_memory_id = OLD.id;
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

CREATE TRIGGER episodes_scrub_replay_subjects AFTER DELETE ON public.episodes
  FOR EACH ROW EXECUTE FUNCTION lore.scrub_replays_of_deleted_episode();
-- Deleting a Memory also deletes its Proposals (memories_remove_proposals_before_delete),
-- whose own trigger then scrubs by subject_proposal_id.
CREATE TRIGGER memories_scrub_replay_subjects BEFORE DELETE ON public.memories
  FOR EACH ROW EXECUTE FUNCTION lore.scrub_replays_of_deleted_memory();
CREATE TRIGGER memory_proposals_scrub_replay_subjects AFTER DELETE ON public.memory_proposals
  FOR EACH ROW EXECUTE FUNCTION lore.scrub_replays_of_deleted_proposal();

UPDATE public.lore_system_state
SET schema_revision = 9, updated_at = now()
WHERE singleton;
-- migrate:down
