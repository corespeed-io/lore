-- migrate:up transaction:false
-- Schema revision 11: one index that a cascade needs and two that no query can use,
-- built and dropped without blocking writes. CREATE and DROP INDEX CONCURRENTLY take
-- SHARE UPDATE EXCLUSIVE, which conflicts with neither reads nor writes, but they
-- refuse a transaction block, so `bun run db:migrate` applies this file one
-- statement at a time, as it does 0005 and 0008, and commits the final
-- schema_revision UPDATE with the ledger row. Each statement waits for transactions
-- already holding a lock on its table to finish, and none queues ahead of DML, so
-- there is no lock_timeout (SET LOCAL has no effect outside a transaction anyway).
-- A run that stops anywhere earlier leaves revision 10 and no ledger row, and the
-- rerun repeats the whole file: every build is preceded by a drop of whatever an
-- earlier run left, valid or INVALID. Keep exactly one statement per line-ending
-- semicolon and no dollar-quoted bodies.
--
-- It runs after 0010, which adds the compatible_from column its last statement
-- writes. compatible_from stays 9: no revision-9 or revision-10 query depends on
-- either dropped index.

-- Deleting a chunk cascades to its vectors through memory_chunk_embeddings.chunk_id,
-- but the only indexes there lead with generation_id or workspace_id, so every
-- deleted chunk scanned the whole primary-key index. A content update or forget
-- deletes up to 64 chunks.
DROP INDEX CONCURRENTLY IF EXISTS public.memory_chunk_embeddings_chunk_idx;
CREATE INDEX CONCURRENTLY memory_chunk_embeddings_chunk_idx ON public.memory_chunk_embeddings USING btree (chunk_id);

-- Every metadata filter runs as lore_app under RLS, where jsonb @> is not leakproof
-- and so can never become an index condition: the planner must apply the policy
-- first, and the GIN index only cost every Memory write (proved with EXPLAIN under
-- SET ROLE lore_app and enable_seqscan=off in
-- tests/server/schema-revision-11-upgrade.test.ts, the reason 0002 and 0003 dropped
-- the chunk GINs).
DROP INDEX CONCURRENTLY IF EXISTS public.memories_metadata_gin_idx;

-- (workspace_id, source_memory_id) is a strict prefix of the unique natural key
-- memory_links_workspace_id_source_memory_id_target_memory_id_key, which serves
-- every lookup this index could.
DROP INDEX CONCURRENTLY IF EXISTS public.memory_links_workspace_source_idx;

UPDATE public.lore_system_state
SET schema_revision = 11, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
