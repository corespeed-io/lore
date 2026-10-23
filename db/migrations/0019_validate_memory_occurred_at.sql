-- migrate:up
-- Schema revision 19: the occurred_at CHECKs 0018 added NOT VALID are validated. Every
-- row written since 0018 was already checked as it was written, and every older row
-- holds NULL, so this only proves it.
--
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, which blocks neither reads nor
-- writes, while it scans each table once. lock_timeout bounds the wait for a lock
-- that conflicts with it, such as a concurrent VACUUM or another migration.
-- compatible_from stays 9: an older application never reads these columns.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.memories VALIDATE CONSTRAINT memories_occurred_at_check;
ALTER TABLE public.memory_proposals VALIDATE CONSTRAINT memory_proposals_proposed_occurred_at_check;
ALTER TABLE public.memory_proposals VALIDATE CONSTRAINT memory_proposals_occurred_at_change_check;
ALTER TABLE public.memory_proposals VALIDATE CONSTRAINT memory_proposals_check1;

UPDATE public.lore_system_state
SET schema_revision = 19, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
