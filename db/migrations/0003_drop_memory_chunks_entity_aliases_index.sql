-- migrate:up
-- Same finding as migration 0002, one operator further: arraycontains (@>) is
-- as non-leakproof as @@ and LIKE (proleakproof=f), so under RLS the request
-- role can never use the entity-aliases GIN as an index condition. Verified on
-- this schema (2026-08-17, Postgres 18): with enable_seqscan=off, a bare
-- `entity_aliases @> ...` probe under SET ROLE lore_app plans a Seq Scan
-- marked `Disabled: true` — the planner eats the disable penalty rather than
-- use the GIN — while the identical probe as table owner uses
-- memory_chunks_entity_aliases_idx as the Index Cond. The index only cost
-- write amplification on every chunk insert; the generated entity_aliases
-- column stays because the alias channel's scan predicate reads it.
SET LOCAL lock_timeout = '5s';
DROP INDEX IF EXISTS public.memory_chunks_entity_aliases_idx;
UPDATE public.lore_system_state
SET schema_revision = 3, updated_at = now()
WHERE singleton;
-- migrate:down
