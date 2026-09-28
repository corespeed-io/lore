-- migrate:up
-- Schema revision 7: replay records name their subjects in columns, the first of
-- the two releases that move the replay scrub off JSON paths.
--
-- Hard-deleting a Memory, Proposal, or Episode must delete every stored replay
-- body that carries its content. The baseline triggers find those bodies by JSON
-- path (`{memory,id}`, `{proposal,id}`, `{proposal,targetMemoryId}`,
-- `{proposal,acceptedMemoryId}`, `{episode,id}`), so renaming a key in a replayed
-- response would silently stop the scrub. This release records each subject in its
-- own column instead: this migration adds the columns, 0008 indexes them without
-- blocking writes, and 0009 adds the triggers that scrub by them. The application
-- writes the columns from this release on.
--
-- Existing rows are not backfilled. Rewriting the ledger here would hold the
-- ACCESS EXCLUSIVE lock ADD COLUMN takes, and so block every idempotent write, for
-- as long as the rewrite runs, and the baseline JSON-path triggers, which stay in
-- this release, already scrub every row written before it. The second release, once
-- every instance writes the columns and the 24-hour ledger has turned over, drops
-- the JSON-path scrub and its 0005 indexes.
--
-- Adding nullable columns without defaults changes only the catalog, so the lock is
-- brief; under load it still queues behind open transactions, so fail fast and let
-- the deploy retry.
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

UPDATE public.lore_system_state
SET schema_revision = 7, updated_at = now()
WHERE singleton;
-- migrate:down
