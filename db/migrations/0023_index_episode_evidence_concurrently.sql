-- migrate:up transaction:false
-- Schema revision 23: the GIN indexes lore.episode_evidence_candidates (0022)
-- probes, each leading with workspace_id (through btree_gin) so a probe never
-- collects another Workspace's matches. The baseline's single-column GINs on
-- episode_evidence_chunks served no request: under RLS a non-leakproof operator is
-- never an index condition. The channels now run inside that SECURITY DEFINER
-- function, outside RLS, so these serve every Episode evidence search
-- (tests/server/episode-evidence-candidates.test.ts proves the plans use them), and
-- the old ones go.
--
-- CREATE and DROP INDEX CONCURRENTLY take SHARE UPDATE EXCLUSIVE, which conflicts
-- with neither reads nor writes, but refuse a transaction block, so `bun run
-- db:migrate` applies this file one statement at a time, as it does 0013, and
-- commits the final schema_revision UPDATE with the ledger row. A run that stops
-- anywhere earlier leaves revision 22 and no ledger row, and the rerun repeats the
-- whole file: every build is preceded by a drop of whatever an earlier run left,
-- valid or INVALID. Keep exactly one statement per line-ending semicolon and no
-- dollar-quoted bodies.
--
-- Until this commits, lore.episode_evidence_candidates answers the same candidates
-- by scanning. compatible_from stays 9: no older query can use the dropped indexes.

-- The simple channel.
DROP INDEX CONCURRENTLY IF EXISTS public.episode_evidence_chunks_workspace_search_idx;
CREATE INDEX CONCURRENTLY episode_evidence_chunks_workspace_search_idx ON public.episode_evidence_chunks USING gin (workspace_id, search_vector);

-- The English channel.
DROP INDEX CONCURRENTLY IF EXISTS public.episode_evidence_chunks_workspace_search_english_idx;
CREATE INDEX CONCURRENTLY episode_evidence_chunks_workspace_search_english_idx ON public.episode_evidence_chunks USING gin (workspace_id, search_vector_english);

-- The CJK channel, over the expression its probe tests.
DROP INDEX CONCURRENTLY IF EXISTS public.episode_evidence_chunks_workspace_cjk_grams_idx;
CREATE INDEX CONCURRENTLY episode_evidence_chunks_workspace_cjk_grams_idx ON public.episode_evidence_chunks USING gin (workspace_id, lore.extract_cjk_grams(normalize(content, NFC)));

-- The baseline's indexes, which no request can use.
DROP INDEX CONCURRENTLY IF EXISTS public.episode_evidence_chunks_search_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.episode_evidence_chunks_search_english_idx;

UPDATE public.lore_system_state
SET schema_revision = 23, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
