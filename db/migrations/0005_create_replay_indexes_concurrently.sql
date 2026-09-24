-- migrate:up transaction:false
-- Schema revision 5: the replay-scrub and import-provenance indexes, built
-- without blocking writes. A plain CREATE INDEX holds SHARE on its table until
-- its transaction commits, and SHARE blocks every INSERT, UPDATE, and DELETE. The
-- SDK sends an Idempotency-Key on every write, so building these inside a
-- transactional migration would stall every idempotent write for the whole build.
-- CREATE INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE, which conflicts with
-- neither reads nor writes, but it refuses to run inside a transaction block.
-- Hence transaction:false, and hence no lock_timeout: SET LOCAL has no effect
-- outside a transaction, and none of these statements queues ahead of DML.
--
-- dbmate 2.35 would still send this whole file as one multi-statement query, which
-- PostgreSQL runs as one implicit transaction block, so `bun run db:migrate`
-- applies it itself, one statement at a time
-- (scripts/database/lib/migration-statements.ts). Keep exactly one statement per
-- line-ending semicolon and no dollar-quoted bodies. The wrapper commits the final
-- schema_revision UPDATE in one transaction with this version's ledger row, so a
-- run that stops anywhere earlier leaves revision 4 and no ledger row behind.
--
-- Each index is dropped and then built, deliberately. A concurrent build that
-- fails or is cancelled leaves an INVALID index that every write still maintains
-- but no query can use, and CREATE INDEX CONCURRENTLY IF NOT EXISTS would skip it
-- forever. Because a stopped run records nothing, the rerun repeats the whole file:
-- DROP INDEX CONCURRENTLY IF EXISTS removes whatever the earlier run left, valid or
-- not, and the build starts clean.

-- Hard-deleting a Memory, Proposal, or Episode scrubs replay bodies that mention
-- it. Those triggers compared an unindexed JSON path, so every delete scanned and
-- detoasted the Workspace's whole 24-hour replay ledger. Each partial expression
-- index matches one trigger predicate exactly; the triggers run as their owner,
-- so RLS never keeps the planner off them.
DROP INDEX CONCURRENTLY IF EXISTS public.request_idempotency_records_memory_id_idx;
CREATE INDEX CONCURRENTLY request_idempotency_records_memory_id_idx ON public.request_idempotency_records USING btree (workspace_id, ((response_body #>> '{memory,id}'::text[]))) WHERE ((response_body #>> '{memory,id}'::text[]) IS NOT NULL);
DROP INDEX CONCURRENTLY IF EXISTS public.request_idempotency_records_proposal_id_idx;
CREATE INDEX CONCURRENTLY request_idempotency_records_proposal_id_idx ON public.request_idempotency_records USING btree (workspace_id, ((response_body #>> '{proposal,id}'::text[]))) WHERE ((response_body #>> '{proposal,id}'::text[]) IS NOT NULL);
DROP INDEX CONCURRENTLY IF EXISTS public.request_idempotency_records_proposal_target_idx;
CREATE INDEX CONCURRENTLY request_idempotency_records_proposal_target_idx ON public.request_idempotency_records USING btree (workspace_id, ((response_body #>> '{proposal,targetMemoryId}'::text[]))) WHERE ((response_body #>> '{proposal,targetMemoryId}'::text[]) IS NOT NULL);
DROP INDEX CONCURRENTLY IF EXISTS public.request_idempotency_records_proposal_accepted_idx;
CREATE INDEX CONCURRENTLY request_idempotency_records_proposal_accepted_idx ON public.request_idempotency_records USING btree (workspace_id, ((response_body #>> '{proposal,acceptedMemoryId}'::text[]))) WHERE ((response_body #>> '{proposal,acceptedMemoryId}'::text[]) IS NOT NULL);
DROP INDEX CONCURRENTLY IF EXISTS public.request_idempotency_records_episode_id_idx;
CREATE INDEX CONCURRENTLY request_idempotency_records_episode_id_idx ON public.request_idempotency_records USING btree (workspace_id, ((response_body #>> '{episode,id}'::text[]))) WHERE ((response_body #>> '{episode,id}'::text[]) IS NOT NULL);

-- An import receipt replays only while its imported Memories still exist, which the
-- import checks by import_id on every re-import of the same archive. Only the
-- (workspace_id, memory_id) key existed, so that check (and the cascade when a
-- receipt is deleted) scanned every provenance row in the Workspace. Imports
-- write this table too, so it is built concurrently for the same reason.
DROP INDEX CONCURRENTLY IF EXISTS public.memory_import_provenance_import_idx;
CREATE INDEX CONCURRENTLY memory_import_provenance_import_idx ON public.memory_import_provenance USING btree (workspace_id, import_id);

UPDATE public.lore_system_state
SET schema_revision = 5, updated_at = now()
WHERE singleton;
-- migrate:down
