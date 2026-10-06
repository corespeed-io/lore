-- migrate:up transaction:false
-- Schema revision 13: the GIN indexes lore.lexical_candidates (0012) probes, each
-- leading with workspace_id (through btree_gin) so a probe never collects another
-- Workspace's matches. 0002 and 0003 dropped single-column GINs on the same chunk
-- columns because no request could use them: under RLS a non-leakproof operator is
-- never an index condition. The lexical channels now run inside that SECURITY
-- DEFINER function, outside RLS, so these serve every search
-- (tests/server/lexical-candidates.test.ts proves the plans use them).
--
-- CREATE and DROP INDEX CONCURRENTLY take SHARE UPDATE EXCLUSIVE, which conflicts
-- with neither reads nor writes, but refuse a transaction block, so `bun run
-- db:migrate` applies this file one statement at a time, as it does 0005, 0008, and
-- 0011, and commits the final schema_revision UPDATE with the ledger row. A run that
-- stops anywhere earlier leaves revision 12 and no ledger row, and the rerun repeats
-- the whole file: every build is preceded by a drop of whatever an earlier run left,
-- valid or INVALID. Keep exactly one statement per line-ending semicolon and no
-- dollar-quoted bodies.
--
-- Until this commits, lore.lexical_candidates answers the same candidates by
-- scanning, so an application of revision 12 is correct, only slower, against
-- revision 12. compatible_from stays 9: no older query depends on these indexes.

-- The simple channel.
DROP INDEX CONCURRENTLY IF EXISTS public.memory_chunks_workspace_search_idx;
CREATE INDEX CONCURRENTLY memory_chunks_workspace_search_idx ON public.memory_chunks USING gin (workspace_id, search_vector);

-- The English and relaxed English channels.
DROP INDEX CONCURRENTLY IF EXISTS public.memory_chunks_workspace_search_english_idx;
CREATE INDEX CONCURRENTLY memory_chunks_workspace_search_english_idx ON public.memory_chunks USING gin (workspace_id, search_vector_english);

-- The entity alias channel.
DROP INDEX CONCURRENTLY IF EXISTS public.memory_chunks_workspace_entity_aliases_idx;
CREATE INDEX CONCURRENTLY memory_chunks_workspace_entity_aliases_idx ON public.memory_chunks USING gin (workspace_id, entity_aliases);

-- The CJK channel, over the expression its probe tests (see lore.extract_cjk_grams).
DROP INDEX CONCURRENTLY IF EXISTS public.memory_chunks_workspace_cjk_grams_idx;
CREATE INDEX CONCURRENTLY memory_chunks_workspace_cjk_grams_idx ON public.memory_chunks USING gin (workspace_id, lore.extract_cjk_grams(content));

UPDATE public.lore_system_state
SET schema_revision = 13, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
