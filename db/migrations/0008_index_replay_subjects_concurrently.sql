-- migrate:up transaction:false
-- Schema revision 8: the indexes behind 0007's replay-subject scrub, built without
-- blocking writes. Every hard delete of a Memory, Proposal, or Episode runs one of
-- the 0007 triggers, so without these each delete would scan the Workspace's
-- 24-hour replay ledger. A plain CREATE INDEX holds SHARE until commit and blocks
-- every idempotent write, so these build CONCURRENTLY, which refuses a transaction
-- block: `bun run db:migrate` applies this file one statement at a time, as it does
-- 0005, and commits the final schema_revision UPDATE with the ledger row.
--
-- Each index is dropped and then built: a stopped concurrent build leaves an
-- INVALID index, and because a stopped run records nothing, the rerun repeats the
-- whole file. Keep exactly one statement per line-ending semicolon and no
-- dollar-quoted bodies. The partial predicates match the triggers' own, and the
-- triggers run as their owner, so RLS never keeps the planner off them.
DROP INDEX CONCURRENTLY IF EXISTS public.request_idempotency_records_subject_memory_idx;
CREATE INDEX CONCURRENTLY request_idempotency_records_subject_memory_idx ON public.request_idempotency_records USING btree (workspace_id, subject_memory_id) WHERE (subject_memory_id IS NOT NULL);

DROP INDEX CONCURRENTLY IF EXISTS public.request_idempotency_records_subject_proposal_idx;
CREATE INDEX CONCURRENTLY request_idempotency_records_subject_proposal_idx ON public.request_idempotency_records USING btree (workspace_id, subject_proposal_id) WHERE (subject_proposal_id IS NOT NULL);

DROP INDEX CONCURRENTLY IF EXISTS public.request_idempotency_records_proposal_target_memory_idx;
CREATE INDEX CONCURRENTLY request_idempotency_records_proposal_target_memory_idx ON public.request_idempotency_records USING btree (workspace_id, proposal_target_memory_id) WHERE (proposal_target_memory_id IS NOT NULL);

DROP INDEX CONCURRENTLY IF EXISTS public.request_idempotency_records_proposal_accepted_memory_idx;
CREATE INDEX CONCURRENTLY request_idempotency_records_proposal_accepted_memory_idx ON public.request_idempotency_records USING btree (workspace_id, proposal_accepted_memory_id) WHERE (proposal_accepted_memory_id IS NOT NULL);

DROP INDEX CONCURRENTLY IF EXISTS public.request_idempotency_records_subject_episode_idx;
CREATE INDEX CONCURRENTLY request_idempotency_records_subject_episode_idx ON public.request_idempotency_records USING btree (workspace_id, subject_episode_id) WHERE (subject_episode_id IS NOT NULL);

UPDATE public.lore_system_state
SET schema_revision = 8, updated_at = now()
WHERE singleton;
-- migrate:down
