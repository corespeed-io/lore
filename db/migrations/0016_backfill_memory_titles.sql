-- migrate:up
-- Schema revision 16: every Memory whose metadata carries a string title gets it as
-- its title, and the title and gloss CHECKs 0015 added NOT VALID are validated.
-- There is nothing to copy into a gloss: it is new, and the writing agent supplies it.
--
-- Until revision 15 the web UI and the Graph showed metadata.title, trimmed, as a
-- Memory's title; from 15 on they read only the title column. Copying keeps what
-- each Memory showed. The copy is the same trimmed text, taken only when it obeys the
-- title rule (memories_title_check); a longer or multi-line one stays only in
-- metadata, and the Memory shows its first line, as one without metadata.title did.
-- Metadata itself is left exactly as written, and a Memory that already has a title
-- keeps it.
--
-- A copied title changes the Memory's representation, so its version advances, and
-- with it the strong ETag, the way 0004's Agent deletion advances it. updated_at is
-- left alone: recency, list order, and cursors do not move. An embedding job still
-- waiting for the old version is moved to the new one in the same statement, since a
-- claim cancels a job whose version no longer matches its Memory, which would leave
-- the Memory's missing vectors unembedded. The update records a memory.updated event
-- with title as the changed field, and no actor.
--
-- It takes ROW EXCLUSIVE on memories and memory_embedding_jobs and row locks on the
-- Memories it titles, never a lock that blocks reads, and VALIDATE CONSTRAINT takes
-- SHARE UPDATE EXCLUSIVE, which blocks neither reads nor writes. lock_timeout bounds
-- the wait for a row a request holds. compatible_from stays 9: an older application
-- never reads the title column.
SET LOCAL lock_timeout = '5s';

WITH candidate AS (
  -- JavaScript's String.prototype.trim set, which the UI trimmed with.
  SELECT
    memory.workspace_id,
    memory.id,
    btrim(
      memory.metadata ->> 'title',
      E'\t\n\u000B\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'
    ) AS title
  FROM public.memories memory
  WHERE memory.title IS NULL
    AND jsonb_typeof(memory.metadata -> 'title') = 'string'
),
titled AS (
  UPDATE public.memories memory
  SET title = candidate.title,
      version = memory.version + 1
  FROM candidate
  WHERE memory.workspace_id = candidate.workspace_id
    AND memory.id = candidate.id
    AND char_length(candidate.title) <= 256
    AND candidate.title !~ '[\u0001-\u001F\u007F-\u009F\u2028\u2029]'
    AND candidate.title ~ '[^ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]'
  RETURNING memory.workspace_id, memory.id, memory.version
)
UPDATE public.memory_embedding_jobs job
SET memory_version = titled.version,
    updated_at = now()
FROM titled
WHERE job.workspace_id = titled.workspace_id
  AND job.memory_id = titled.id
  AND job.memory_version = titled.version - 1
  AND job.status IN ('pending', 'processing');

ALTER TABLE public.memories VALIDATE CONSTRAINT memories_title_check;
ALTER TABLE public.memories VALIDATE CONSTRAINT memories_gloss_check;
ALTER TABLE public.memory_proposals VALIDATE CONSTRAINT memory_proposals_proposed_title_check;
ALTER TABLE public.memory_proposals VALIDATE CONSTRAINT memory_proposals_title_change_check;
ALTER TABLE public.memory_proposals VALIDATE CONSTRAINT memory_proposals_proposed_gloss_check;
ALTER TABLE public.memory_proposals VALIDATE CONSTRAINT memory_proposals_gloss_change_check;
ALTER TABLE public.memory_proposals VALIDATE CONSTRAINT memory_proposals_check1;

UPDATE public.lore_system_state
SET schema_revision = 16, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
