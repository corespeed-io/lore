-- migrate:up
-- Under RLS the request role cannot use non-leakproof operators (@@, LIKE) as
-- index conditions, so these two GIN indexes never served Memory search and only
-- cost write amplification (verified with EXPLAIN under SET ROLE lore_app and
-- enable_seqscan=off). Lexical channels are workspace-bounded scans by design;
-- the tsvector columns remain because they power the scan predicates.
-- DROP INDEX takes ACCESS EXCLUSIVE on memory_chunks; on a live deployment a
-- blocked drop would queue behind readers and stall everything after it. Fail
-- retryably instead of stalling.
SET LOCAL lock_timeout = '5s';
DROP INDEX IF EXISTS public.memory_chunks_search_idx;
DROP INDEX IF EXISTS public.memory_chunks_search_english_idx;
UPDATE public.lore_system_state
SET schema_revision = 2, updated_at = now()
WHERE singleton;
-- migrate:down
