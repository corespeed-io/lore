-- migrate:up transaction:false
-- Schema revision 17: the GIN indexes the name channels of lore.lexical_candidates
-- (0015) probe, each leading with workspace_id (through btree_gin) as 0013's chunk
-- indexes do, over exactly the expression its channel tests: a Memory's names, its
-- title and English gloss, as lore.memory_name_text joins them. A Memory with
-- neither indexes no term, so Memories without names cost each index almost nothing.
--
-- CREATE and DROP INDEX CONCURRENTLY take SHARE UPDATE EXCLUSIVE, which conflicts
-- with neither reads nor writes, but refuse a transaction block, so `bun run
-- db:migrate` applies this file one statement at a time, as it does 0013, and
-- commits the final schema_revision UPDATE with the ledger row. A run that stops
-- anywhere earlier leaves revision 16 and no ledger row, and the rerun repeats the
-- whole file: every build is preceded by a drop of whatever an earlier run left,
-- valid or INVALID. Keep exactly one statement per line-ending semicolon and no
-- dollar-quoted bodies.
--
-- Until this commits, the name channels answer the same candidates by scanning the
-- Workspace's Memories. compatible_from stays 9: no older query depends on these
-- indexes.

-- The simple name channel.
DROP INDEX CONCURRENTLY IF EXISTS public.memories_workspace_name_search_idx;
CREATE INDEX CONCURRENTLY memories_workspace_name_search_idx ON public.memories USING gin (workspace_id, to_tsvector('simple'::regconfig, lore.memory_name_text(title, gloss)));

-- The English and relaxed English name channels.
DROP INDEX CONCURRENTLY IF EXISTS public.memories_workspace_name_search_english_idx;
CREATE INDEX CONCURRENTLY memories_workspace_name_search_english_idx ON public.memories USING gin (workspace_id, to_tsvector('english'::regconfig, lore.memory_name_text(title, gloss)));

-- The CJK name channel (see lore.extract_cjk_grams).
DROP INDEX CONCURRENTLY IF EXISTS public.memories_workspace_name_cjk_grams_idx;
CREATE INDEX CONCURRENTLY memories_workspace_name_cjk_grams_idx ON public.memories USING gin (workspace_id, lore.extract_cjk_grams(lore.memory_name_text(title, gloss)));

UPDATE public.lore_system_state
SET schema_revision = 17, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
