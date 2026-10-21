-- migrate:up
-- Schema revision 15: Memory titles and glosses. A Memory may carry a title, a short
-- plain-text name kept apart from its content, and a gloss, an English rendering of
-- content written in another language, which the writing agent supplies so English
-- keyword search finds the Memory without the dense channel. Both are optional, may
-- be changed or removed, and may repeat; the id stays the Memory's identity. This
-- revision adds the columns and their rules, proposed titles and glosses on Memory
-- Proposals, both in the mutation outbox, name channels in lexical search, and both
-- bounds in capabilities. 0016 copies each Memory's metadata.title into its title and
-- validates the rules; 0017 builds the name indexes.
--
-- The rules (memories_title_check and memories_gloss_check, restated by
-- validateMemoryTitle and validateMemoryGloss in lore-core): one line of at most 256
-- (title) or 512 (gloss) characters, at least one that is not whitespace, and no
-- control character or line or paragraph separator. The CHECKs start NOT VALID, which
-- skips the table scan while this migration holds ACCESS EXCLUSIVE; every new or
-- changed row is checked at once, and 0016 validates the old ones.
--
-- compatible_from stays 9. An application of revision 9 through 14 never names the
-- new columns: it writes neither, its updates keep both, and its Proposal calls reach
-- the old lore.submit_memory_proposal, kept below. Its search gets the name channels
-- through lore.lexical_candidates, which answers the same columns, and fuses them
-- like any other channel.
--
-- It takes ACCESS EXCLUSIVE on memories, then memory_proposals, then
-- lore_system_state. Adding a nullable column, or a NOT NULL one with a constant
-- default, is catalog-only, so each lock lasts milliseconds once granted. Request
-- paths lock a Memory before its Proposals, the same order, so this cannot deadlock
-- with them, and lock_timeout keeps a busy deploy from queueing behind a long
-- transaction. A timeout fails the migration retryably and records nothing.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.memories
  ADD COLUMN title text,
  ADD CONSTRAINT memories_title_check CHECK (
    title IS NULL
    OR (
      char_length(title) <= 256
      AND title !~ '[\u0001-\u001F\u007F-\u009F\u2028\u2029]'
      AND title ~ '[^ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]'
    )
  ) NOT VALID;
COMMENT ON COLUMN public.memories.title IS 'Optional one-line plain-text name, separate from content; may change and may repeat.';
ALTER TABLE public.memories
  ADD COLUMN gloss text,
  ADD CONSTRAINT memories_gloss_check CHECK (
    gloss IS NULL
    OR (
      char_length(gloss) <= 512
      AND gloss !~ '[\u0001-\u001F\u007F-\u009F\u2028\u2029]'
      AND gloss ~ '[^ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]'
    )
  ) NOT VALID;
COMMENT ON COLUMN public.memories.gloss IS 'Optional one-line English rendering of content in another language, for English keyword search.';

-- A Proposal states its title and gloss as changes: the proposed value, NULL unless
-- it changes, and whether it changes. A create sets both (changes_* true, NULL for
-- none). memory_proposals_check1 is rebuilt so an update that changes only the title
-- or gloss is a Proposal.
ALTER TABLE public.memory_proposals
  ADD COLUMN proposed_title text,
  ADD COLUMN changes_title boolean DEFAULT false NOT NULL,
  ADD COLUMN proposed_gloss text,
  ADD COLUMN changes_gloss boolean DEFAULT false NOT NULL,
  ADD CONSTRAINT memory_proposals_proposed_title_check CHECK (
    proposed_title IS NULL
    OR (
      char_length(proposed_title) <= 256
      AND proposed_title !~ '[\u0001-\u001F\u007F-\u009F\u2028\u2029]'
      AND proposed_title ~ '[^ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]'
    )
  ) NOT VALID,
  ADD CONSTRAINT memory_proposals_title_change_check CHECK (
    changes_title OR proposed_title IS NULL
  ) NOT VALID,
  ADD CONSTRAINT memory_proposals_proposed_gloss_check CHECK (
    proposed_gloss IS NULL
    OR (
      char_length(proposed_gloss) <= 512
      AND proposed_gloss !~ '[\u0001-\u001F\u007F-\u009F\u2028\u2029]'
      AND proposed_gloss ~ '[^ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]'
    )
  ) NOT VALID,
  ADD CONSTRAINT memory_proposals_gloss_change_check CHECK (
    changes_gloss OR proposed_gloss IS NULL
  ) NOT VALID,
  DROP CONSTRAINT memory_proposals_check1,
  ADD CONSTRAINT memory_proposals_check1 CHECK (
    (
      kind = 'create'::public.memory_proposal_kind
      AND target_memory_id IS NULL
      AND base_memory_version IS NULL
      AND changes_content
      AND changes_scope
      AND changes_metadata
    )
    OR (
      kind = 'update'::public.memory_proposal_kind
      AND target_memory_id IS NOT NULL
      AND base_memory_version > 0
      AND (changes_content OR changes_scope OR changes_metadata OR changes_title OR changes_gloss)
    )
  ) NOT VALID;
COMMENT ON COLUMN public.memory_proposals.proposed_title IS 'The proposed Memory title, or NULL for none; meaningful only when changes_title.';
COMMENT ON COLUMN public.memory_proposals.proposed_gloss IS 'The proposed Memory gloss, or NULL for none; meaningful only when changes_gloss.';

-- The outbox names title and gloss among the changed fields. Otherwise the body is 0010's,
-- including the JSON-path replay scrub, which stays until the second release of the
-- replay-subject migration.
CREATE OR REPLACE FUNCTION lore.append_memory_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  changed text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    changed := ARRAY['content', 'metadata', 'scope', 'title', 'gloss'];
    INSERT INTO memory_events (
      id, workspace_id, owner_user_id, memory_scope,
      resource_type, resource_id, event_type,
      actor_user_id, actor_agent_id, request_id,
      after_version, changed_fields, after_content_sha256
    ) VALUES (
      gen_random_uuid(), NEW.workspace_id, NEW.owner_user_id, NEW.scope,
      'memory', NEW.id, 'memory.created',
      lore.current_user_id(), lore.current_agent_id(), lore.current_request_id(),
      NEW.version, changed,
      encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex')
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.content IS DISTINCT FROM NEW.content THEN changed := array_append(changed, 'content'); END IF;
    IF OLD.metadata IS DISTINCT FROM NEW.metadata THEN changed := array_append(changed, 'metadata'); END IF;
    IF OLD.scope IS DISTINCT FROM NEW.scope THEN changed := array_append(changed, 'scope'); END IF;
    IF OLD.title IS DISTINCT FROM NEW.title THEN changed := array_append(changed, 'title'); END IF;
    IF OLD.gloss IS DISTINCT FROM NEW.gloss THEN changed := array_append(changed, 'gloss'); END IF;
    INSERT INTO memory_events (
      id, workspace_id, owner_user_id, memory_scope,
      resource_type, resource_id, event_type,
      actor_user_id, actor_agent_id, request_id,
      before_version, after_version, changed_fields,
      before_content_sha256, after_content_sha256
    ) VALUES (
      gen_random_uuid(), NEW.workspace_id, NEW.owner_user_id, NEW.scope,
      'memory', NEW.id, 'memory.updated',
      lore.current_user_id(), lore.current_agent_id(), lore.current_request_id(),
      OLD.version, NEW.version, changed,
      encode(sha256(convert_to(OLD.content, 'UTF8')), 'hex'),
      encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex')
    );
    RETURN NEW;
  END IF;
  -- A hard delete invalidates earlier replay bodies for this Memory so the
  -- idempotency ledger cannot retain deleted user content for its remaining TTL.
  DELETE FROM request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id
    AND replay.response_body #>> '{memory,id}' = OLD.id::text;
  INSERT INTO memory_events (
    id, workspace_id, owner_user_id, memory_scope,
    resource_type, resource_id, event_type,
    actor_user_id, actor_agent_id, request_id,
    before_version, changed_fields, before_content_sha256,
    expires_at
  ) VALUES (
    gen_random_uuid(), OLD.workspace_id, OLD.owner_user_id, OLD.scope,
    'memory', OLD.id, 'memory.deleted',
    lore.current_user_id(), lore.current_agent_id(), lore.current_request_id(),
    OLD.version, ARRAY['content', 'metadata', 'scope', 'title', 'gloss'],
    encode(sha256(convert_to(OLD.content, 'UTF8')), 'hex'),
    now() + interval '30 days'
  );
  -- The cascade deletes this Memory's Links after its row is gone, so the Link
  -- trigger finds no source and skips its outbound Links; an inbound Link's source
  -- survives and the Link trigger records it. Record each outbound Link here, with
  -- the columns and expiry the Link trigger gives a deleted Link. Links cannot point
  -- at their own source (memory_links_check), so no Link is recorded twice.
  INSERT INTO memory_events (
    id, workspace_id, owner_user_id, memory_scope,
    resource_type, resource_id, source_memory_id, related_memory_id, event_type,
    actor_user_id, actor_agent_id, request_id, changed_fields,
    expires_at
  )
  SELECT
    gen_random_uuid(), link.workspace_id, OLD.owner_user_id, OLD.scope,
    'memory_link', link.id, link.source_memory_id, link.target_memory_id, 'memory_link.deleted',
    lore.current_user_id(), lore.current_agent_id(), lore.current_request_id(),
    ARRAY['endpoints', 'kind', 'metadata', 'weight'],
    now() + interval '30 days'
  FROM memory_links link
  WHERE link.workspace_id = OLD.workspace_id
    AND link.source_memory_id = OLD.id
  ORDER BY link.created_at, link.id;
  RETURN OLD;
END
$$;

-- The submission with title and gloss. The baseline's 13-argument function stays for
-- applications of revision 14 and older, which call it during a rolling deploy; it
-- proposes neither (changes_* false, proposed_* NULL). This one takes the same checks
-- and adds each value and whether the Proposal changes it.
CREATE FUNCTION lore.submit_memory_proposal(
    target_workspace_id uuid,
    target_owner_user_id uuid,
    target_actor_kind text,
    target_agent_id uuid,
    target_kind public.memory_proposal_kind,
    target_memory_id uuid,
    target_base_memory_version integer,
    target_content text,
    target_scope public.memory_scope,
    target_metadata jsonb,
    target_changes_content boolean,
    target_changes_scope boolean,
    target_changes_metadata boolean,
    target_title text,
    target_changes_title boolean,
    target_gloss text,
    target_changes_gloss boolean
) RETURNS SETOF public.memory_proposals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NOT lore.can_write_memory(target_workspace_id, target_owner_user_id)
    OR target_actor_kind IS DISTINCT FROM (CASE
      WHEN lore.current_agent_id() IS NULL THEN 'human'
      ELSE 'agent'
    END)
    OR target_agent_id IS DISTINCT FROM lore.current_agent_id()
  THEN
    RAISE EXCEPTION 'Actor cannot submit this Memory Proposal'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  INSERT INTO public.memory_proposals (
    id, workspace_id, owner_user_id, proposed_by_actor_kind,
    proposed_by_agent_id, kind, target_memory_id, base_memory_version,
    proposed_content, proposed_scope, proposed_metadata, proposed_title, proposed_gloss,
    changes_content, changes_scope, changes_metadata, changes_title, changes_gloss
  ) VALUES (
    gen_random_uuid(), target_workspace_id, target_owner_user_id, target_actor_kind,
    target_agent_id, target_kind, target_memory_id, target_base_memory_version,
    target_content, target_scope, target_metadata, target_title, target_gloss,
    target_changes_content, target_changes_scope, target_changes_metadata, target_changes_title,
    target_changes_gloss
  )
  RETURNING public.memory_proposals.*;
END
$$;
COMMENT ON FUNCTION lore.submit_memory_proposal(uuid, uuid, text, uuid, public.memory_proposal_kind, uuid, integer, text, public.memory_scope, jsonb, boolean, boolean, boolean, text, boolean, text, boolean) IS 'Submits a Memory Proposal, title and gloss included, after the same write-authority and Actor checks as the 13-argument form.';
REVOKE ALL ON FUNCTION lore.submit_memory_proposal(uuid, uuid, text, uuid, public.memory_proposal_kind, uuid, integer, text, public.memory_scope, jsonb, boolean, boolean, boolean, text, boolean, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.submit_memory_proposal(uuid, uuid, text, uuid, public.memory_proposal_kind, uuid, integer, text, public.memory_scope, jsonb, boolean, boolean, boolean, text, boolean, text, boolean) TO lore_app;

-- The review guard keeps the title and gloss columns as immutable as the others, and
-- an accepted receipt must match the Memory's title and gloss as it matches content,
-- scope, and metadata: a create's always (NULL when none was proposed), an update's
-- only when the Proposal changes it. An application of revision 14 accepting a
-- Proposal that sets either would write the Memory without it, so this check refuses
-- that acceptance rather than let it be lost; the window lasts a rolling deploy.
CREATE OR REPLACE FUNCTION lore.protect_memory_proposal_review() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NEW.proposed_by_agent_id IS DISTINCT FROM OLD.proposed_by_agent_id THEN
    IF NEW.proposed_by_agent_id IS NULL
      AND OLD.proposed_by_agent_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.agents WHERE id = OLD.proposed_by_agent_id
      )
      AND NEW.id IS NOT DISTINCT FROM OLD.id
      AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
      AND NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id
      AND NEW.proposed_by_actor_kind IS NOT DISTINCT FROM OLD.proposed_by_actor_kind
      AND NEW.kind IS NOT DISTINCT FROM OLD.kind
      AND NEW.target_memory_id IS NOT DISTINCT FROM OLD.target_memory_id
      AND NEW.base_memory_version IS NOT DISTINCT FROM OLD.base_memory_version
      AND NEW.proposed_content IS NOT DISTINCT FROM OLD.proposed_content
      AND NEW.proposed_scope IS NOT DISTINCT FROM OLD.proposed_scope
      AND NEW.proposed_metadata IS NOT DISTINCT FROM OLD.proposed_metadata
      AND NEW.proposed_title IS NOT DISTINCT FROM OLD.proposed_title
      AND NEW.proposed_gloss IS NOT DISTINCT FROM OLD.proposed_gloss
      AND NEW.changes_content IS NOT DISTINCT FROM OLD.changes_content
      AND NEW.changes_scope IS NOT DISTINCT FROM OLD.changes_scope
      AND NEW.changes_metadata IS NOT DISTINCT FROM OLD.changes_metadata
      AND NEW.changes_title IS NOT DISTINCT FROM OLD.changes_title
      AND NEW.changes_gloss IS NOT DISTINCT FROM OLD.changes_gloss
      AND NEW.status IS NOT DISTINCT FROM OLD.status
      AND NEW.reviewed_by_user_id IS NOT DISTINCT FROM OLD.reviewed_by_user_id
      AND NEW.accepted_memory_id IS NOT DISTINCT FROM OLD.accepted_memory_id
      AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
      AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
      AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Memory Proposal provenance is immutable'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.proposed_by_actor_kind IS DISTINCT FROM OLD.proposed_by_actor_kind
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.target_memory_id IS DISTINCT FROM OLD.target_memory_id
    OR NEW.base_memory_version IS DISTINCT FROM OLD.base_memory_version
    OR NEW.proposed_content IS DISTINCT FROM OLD.proposed_content
    OR NEW.proposed_scope IS DISTINCT FROM OLD.proposed_scope
    OR NEW.proposed_metadata IS DISTINCT FROM OLD.proposed_metadata
    OR NEW.proposed_title IS DISTINCT FROM OLD.proposed_title
    OR NEW.proposed_gloss IS DISTINCT FROM OLD.proposed_gloss
    OR NEW.changes_content IS DISTINCT FROM OLD.changes_content
    OR NEW.changes_scope IS DISTINCT FROM OLD.changes_scope
    OR NEW.changes_metadata IS DISTINCT FROM OLD.changes_metadata
    OR NEW.changes_title IS DISTINCT FROM OLD.changes_title
    OR NEW.changes_gloss IS DISTINCT FROM OLD.changes_gloss
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Memory Proposal content and identity are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'pending'
    OR NEW.status NOT IN ('accepted', 'rejected')
    OR NEW.reviewed_by_user_id IS DISTINCT FROM lore.current_user_id()
    OR NEW.reviewed_at IS NULL
    OR NEW.expires_at IS DISTINCT FROM NEW.reviewed_at + interval '30 days'
  THEN
    RAISE EXCEPTION 'Invalid Memory Proposal review transition'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'accepted' AND OLD.kind = 'update' THEN
    IF NEW.accepted_memory_id IS DISTINCT FROM OLD.target_memory_id
      OR NOT EXISTS (
        SELECT 1
        FROM public.memories memory
        WHERE memory.id = NEW.accepted_memory_id
          AND memory.workspace_id = OLD.workspace_id
          AND memory.owner_user_id = OLD.owner_user_id
          AND memory.version = OLD.base_memory_version + 1
          AND memory.content = OLD.proposed_content
          AND memory.scope = OLD.proposed_scope
          AND memory.metadata = OLD.proposed_metadata
          AND (NOT OLD.changes_title OR memory.title IS NOT DISTINCT FROM OLD.proposed_title)
          AND (NOT OLD.changes_gloss OR memory.gloss IS NOT DISTINCT FROM OLD.proposed_gloss)
      )
    THEN
      RAISE EXCEPTION 'Accepted update receipt must match the canonical Memory'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.status = 'accepted' AND OLD.kind = 'create' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.memories memory
      WHERE memory.id = NEW.accepted_memory_id
        AND memory.workspace_id = OLD.workspace_id
        AND memory.owner_user_id = OLD.owner_user_id
        AND memory.created_by_agent_id IS NULL
        AND memory.version = 1
        AND memory.content = OLD.proposed_content
        AND memory.scope = OLD.proposed_scope
        AND memory.metadata = OLD.proposed_metadata
        AND memory.title IS NOT DISTINCT FROM OLD.proposed_title
        AND memory.gloss IS NOT DISTINCT FROM OLD.proposed_gloss
        AND memory.created_at >= OLD.created_at
    )
    THEN
      RAISE EXCEPTION 'Accepted create receipt must match the canonical Memory'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- A Memory's names, as the name channels read them: its title and its English
-- gloss, joined by a space, or NULL when it has neither. 0017 indexes expressions over
-- it, so it must be IMMUTABLE; it only joins text. lore_app writes the rows those
-- indexes cover, so it may execute it, as it may lore.extract_cjk_grams.
CREATE FUNCTION lore.memory_name_text(title text, gloss text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  SELECT CASE
    WHEN title IS NULL THEN gloss
    WHEN gloss IS NULL THEN title
    ELSE title || ' ' || gloss
  END
$$;
COMMENT ON FUNCTION lore.memory_name_text(text, text) IS 'A Memory''s title and English gloss as one text, or NULL: what the name channels and their indexes read.';
REVOKE ALL ON FUNCTION lore.memory_name_text(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.memory_name_text(text, text) TO lore_app;

-- 0012's channels, unchanged, plus four name channels that mirror the content
-- channels over a Memory's names (its title and English gloss): simple and English
-- full text, relaxed English terms (two or more), and CJK grams. Names belong to the
-- whole Memory, so a name match answers the Memory's first chunk (ordinal 0), the
-- chunk a title most often introduces. The engine fuses every channel alike, so a
-- name match adds to that chunk's reciprocal-rank score. A gloss lets an English
-- query find a Memory written in another language without the dense channel. Until
-- 0017 builds their indexes, the name channels read the Workspace's Memories by
-- scanning; the answer is the same.
CREATE OR REPLACE FUNCTION lore.lexical_candidates(
    target_workspace_id uuid,
    search_query text,
    relaxed_terms text[],
    cjk_query_grams text[],
    alias_limit integer,
    scope_filter public.memory_scope,
    updated_after timestamp with time zone,
    updated_before timestamp with time zone,
    metadata_filter jsonb,
    excluded_memory_ids uuid[],
    candidate_limit integer
) RETURNS TABLE(channel text, chunk_id uuid, memory_id uuid, candidate_rank bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    ROWS 200
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    SET plan_cache_mode TO 'force_custom_plan'
    AS $$
  WITH visible_memories AS NOT MATERIALIZED (
    -- Inlined into each channel (a CTE named more than once is otherwise
    -- materialized: every visible Memory, read once per search), so the planner
    -- drives each channel from its own index and looks Memories up by key.
    SELECT memory.id, memory.workspace_id, memory.updated_at, memory.title, memory.gloss
    FROM public.memories memory
    WHERE memory.workspace_id = target_workspace_id
      AND target_workspace_id = lore.current_workspace_id()
      AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
      AND (memory.scope = 'shared'::public.memory_scope OR memory.owner_user_id = lore.current_user_id())
      AND (scope_filter IS NULL OR memory.scope = scope_filter)
      AND (updated_after IS NULL OR memory.updated_at >= updated_after)
      AND (updated_before IS NULL OR memory.updated_at < updated_before)
      AND (metadata_filter IS NULL OR memory.metadata @> metadata_filter)
      AND NOT (memory.id = ANY(excluded_memory_ids))
  ),
  simple_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', search_query), 32) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM public.memory_chunks chunk
    JOIN visible_memories memory
      ON memory.id = chunk.memory_id
     AND memory.workspace_id = chunk.workspace_id
    WHERE chunk.workspace_id = target_workspace_id
      AND chunk.search_vector @@ websearch_to_tsquery('simple', search_query)
    ORDER BY ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', search_query), 32) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  english_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english', search_query), 32) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM public.memory_chunks chunk
    JOIN visible_memories memory
      ON memory.id = chunk.memory_id
     AND memory.workspace_id = chunk.workspace_id
    WHERE chunk.workspace_id = target_workspace_id
      AND chunk.search_vector_english @@ websearch_to_tsquery('english', search_query)
    ORDER BY ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english', search_query), 32) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  english_query_terms AS MATERIALIZED (
    -- One row per distinct term query, numbered for the pairs below.
    SELECT row_number() OVER (ORDER BY grouped.query::text) AS ordinal, grouped.query, grouped.weight
    FROM (
      SELECT
        plainto_tsquery('english', term) AS query,
        max(
          CASE
            WHEN term ~ '^[[:upper:]][[:lower:]]' THEN 4.0
            WHEN term ~ '[[:digit:]]' THEN 3.0
            WHEN char_length(term) >= 10 THEN 1.5
            ELSE 1.0
          END
        ) AS weight
      FROM unnest(relaxed_terms) AS term
      WHERE numnode(plainto_tsquery('english', term)) > 0
      GROUP BY plainto_tsquery('english', term)
    ) grouped
  ),
  relaxed_english_query AS MATERIALIZED (
    -- two_terms matches a chunk exactly when two or more term queries do: the OR of
    -- every pair's AND. It is NULL with fewer than two terms, which matches nothing.
    -- One GIN probe answers it, where counting each term's matches would read every
    -- chunk that matches any one term.
    SELECT
      (SELECT array_agg(term.query ORDER BY term.ordinal) FROM english_query_terms term) AS queries,
      (SELECT array_agg(term.weight ORDER BY term.ordinal) FROM english_query_terms term) AS weights,
      (
        SELECT string_agg(format('(%s) & (%s)', first.query, second.query), ' | ')::tsquery
        FROM english_query_terms first
        JOIN english_query_terms second ON first.ordinal < second.ordinal
      ) AS two_terms
  ),
  relaxed_english_scored AS (
    -- Each matched chunk is scored once over the term arrays, and scored chunks come
    -- out best first, so the join below looks up Memories only until the top
    -- candidate_limit visible ones (and their ties) are known. A chunk's tsvector is
    -- often stored out of line, and every reference to the column fetches it again,
    -- so the vector is read into memory once (concatenating the empty tsvector copies
    -- it unchanged; OFFSET 0 keeps the planner from substituting the expression back
    -- into each reference) and scored from there.
    SELECT
      chunk.id AS chunk_id,
      chunk.memory_id,
      chunk.ordinal,
      (
        SELECT sum(ts_rank_cd(vector.english, term.query, 32) * term.weight)
        FROM unnest(terms.queries, terms.weights) AS term(query, weight)
        WHERE vector.english @@ term.query
      ) AS score
    FROM relaxed_english_query terms
    JOIN public.memory_chunks chunk
      ON chunk.workspace_id = target_workspace_id
     AND chunk.search_vector_english @@ terms.two_terms
    CROSS JOIN LATERAL (SELECT chunk.search_vector_english || ''::tsvector AS english OFFSET 0) vector
    ORDER BY 4 DESC
  ),
  relaxed_english_lexical AS (
    SELECT
      scored.chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY scored.score DESC, memory.updated_at DESC, scored.ordinal DESC, scored.chunk_id
      ) AS candidate_rank
    FROM relaxed_english_scored scored
    JOIN visible_memories memory
      ON memory.id = scored.memory_id
     AND memory.workspace_id = target_workspace_id
    ORDER BY scored.score DESC, memory.updated_at DESC, scored.ordinal DESC, scored.chunk_id
    LIMIT candidate_limit
  ),
  query_entity_aliases AS MATERIALIZED (
    SELECT array_agg(limited.alias ORDER BY limited.ordinal) AS aliases
    FROM (
      SELECT extracted.alias, extracted.ordinal
      FROM unnest(lore.extract_entity_aliases(search_query)) WITH ORDINALITY AS extracted(alias, ordinal)
      ORDER BY extracted.ordinal
      LIMIT alias_limit
    ) limited
  ),
  entity_alias_scored AS (
    -- One GIN probe finds the chunks holding any query alias (NULL aliases, under an
    -- alias_limit of 0, match nothing); each is counted once from its own alias array
    -- (`@>` on one element is `= ANY`), and counted chunks come out best first so
    -- Memories are looked up only until the top candidates are known.
    SELECT
      chunk.id AS chunk_id,
      chunk.memory_id,
      chunk.ordinal,
      matched.match_count,
      matched.specificity
    FROM query_entity_aliases query
    JOIN public.memory_chunks chunk
      ON chunk.workspace_id = target_workspace_id
     AND chunk.entity_aliases && query.aliases
    CROSS JOIN LATERAL (
      SELECT count(*) AS match_count, max(char_length(alias)) AS specificity
      FROM unnest(query.aliases) AS alias
      WHERE alias = ANY(chunk.entity_aliases)
    ) matched
    ORDER BY matched.match_count DESC, matched.specificity DESC
  ),
  entity_alias_lexical AS (
    SELECT
      scored.chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY scored.match_count DESC, scored.specificity DESC,
                 memory.updated_at DESC, scored.ordinal DESC, scored.chunk_id
      ) AS candidate_rank
    FROM entity_alias_scored scored
    JOIN visible_memories memory
      ON memory.id = scored.memory_id
     AND memory.workspace_id = target_workspace_id
    ORDER BY scored.match_count DESC, scored.specificity DESC,
             memory.updated_at DESC, scored.ordinal DESC, scored.chunk_id
    LIMIT candidate_limit
  ),
  cjk_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM unnest(cjk_query_grams) AS gram(gram)
    JOIN public.memory_chunks chunk
      ON chunk.workspace_id = target_workspace_id
     AND lore.extract_cjk_grams(chunk.content) @> ARRAY[gram.gram]
    JOIN visible_memories memory
      ON memory.id = chunk.memory_id
     AND memory.workspace_id = chunk.workspace_id
    GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
    HAVING count(*) >= least(2, cardinality(cjk_query_grams))
    ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  -- The name channels. Each probes lore.memory_name_text(title, gloss) through
  -- 0017's Workspace-leading index on the same expression, then joins the Memory's
  -- first chunk by its (memory_id, ordinal) key. A Memory with neither matches nothing.
  name_simple_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(to_tsvector('simple', lore.memory_name_text(memory.title, memory.gloss)), websearch_to_tsquery('simple', search_query), 32) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM visible_memories memory
    JOIN public.memory_chunks chunk
      ON chunk.memory_id = memory.id
     AND chunk.ordinal = 0
     AND chunk.workspace_id = memory.workspace_id
    WHERE to_tsvector('simple', lore.memory_name_text(memory.title, memory.gloss)) @@ websearch_to_tsquery('simple', search_query)
    ORDER BY ts_rank_cd(to_tsvector('simple', lore.memory_name_text(memory.title, memory.gloss)), websearch_to_tsquery('simple', search_query), 32) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  name_english_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY ts_rank_cd(to_tsvector('english', lore.memory_name_text(memory.title, memory.gloss)), websearch_to_tsquery('english', search_query), 32) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM visible_memories memory
    JOIN public.memory_chunks chunk
      ON chunk.memory_id = memory.id
     AND chunk.ordinal = 0
     AND chunk.workspace_id = memory.workspace_id
    WHERE to_tsvector('english', lore.memory_name_text(memory.title, memory.gloss)) @@ websearch_to_tsquery('english', search_query)
    ORDER BY ts_rank_cd(to_tsvector('english', lore.memory_name_text(memory.title, memory.gloss)), websearch_to_tsquery('english', search_query), 32) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  name_relaxed_english_lexical AS (
    -- The relaxed channel's pair query over the names; they are short, so they are
    -- scored where they matched rather than read once ahead.
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY scored.score DESC, memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM relaxed_english_query terms
    JOIN visible_memories memory
      ON to_tsvector('english', lore.memory_name_text(memory.title, memory.gloss)) @@ terms.two_terms
    CROSS JOIN LATERAL (
      SELECT sum(ts_rank_cd(to_tsvector('english', lore.memory_name_text(memory.title, memory.gloss)), term.query, 32) * term.weight) AS score
      FROM unnest(terms.queries, terms.weights) AS term(query, weight)
      WHERE to_tsvector('english', lore.memory_name_text(memory.title, memory.gloss)) @@ term.query
    ) scored
    JOIN public.memory_chunks chunk
      ON chunk.memory_id = memory.id
     AND chunk.ordinal = 0
     AND chunk.workspace_id = memory.workspace_id
    ORDER BY scored.score DESC, memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  ),
  name_cjk_lexical AS (
    SELECT
      chunk.id AS chunk_id,
      memory.id AS memory_id,
      row_number() OVER (
        ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
                 memory.updated_at DESC, chunk.ordinal DESC, chunk.id
      ) AS candidate_rank
    FROM unnest(cjk_query_grams) AS gram(gram)
    JOIN visible_memories memory
      ON lore.extract_cjk_grams(lore.memory_name_text(memory.title, memory.gloss)) @> ARRAY[gram.gram]
    JOIN public.memory_chunks chunk
      ON chunk.memory_id = memory.id
     AND chunk.ordinal = 0
     AND chunk.workspace_id = memory.workspace_id
    GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
    HAVING count(*) >= least(2, cardinality(cjk_query_grams))
    ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
             memory.updated_at DESC, chunk.ordinal DESC, chunk.id
    LIMIT candidate_limit
  )
  SELECT 'simple', chunk_id, memory_id, candidate_rank FROM simple_lexical
  UNION ALL
  SELECT 'english', chunk_id, memory_id, candidate_rank FROM english_lexical
  UNION ALL
  SELECT 'relaxed_english', chunk_id, memory_id, candidate_rank FROM relaxed_english_lexical
  UNION ALL
  SELECT 'entity_alias', chunk_id, memory_id, candidate_rank FROM entity_alias_lexical
  UNION ALL
  SELECT 'cjk', chunk_id, memory_id, candidate_rank FROM cjk_lexical
  UNION ALL
  SELECT 'name_simple', chunk_id, memory_id, candidate_rank FROM name_simple_lexical
  UNION ALL
  SELECT 'name_english', chunk_id, memory_id, candidate_rank FROM name_english_lexical
  UNION ALL
  SELECT 'name_relaxed_english', chunk_id, memory_id, candidate_rank FROM name_relaxed_english_lexical
  UNION ALL
  SELECT 'name_cjk', chunk_id, memory_id, candidate_rank FROM name_cjk_lexical
$$;

-- The baseline body plus the memoryTitles and memoryGlosses features and their bounds,
-- which DEPLOYMENT_FEATURES and DEPLOYMENT_LIMITS publish from this revision on.
CREATE OR REPLACE FUNCTION lore.portable_core_capabilities() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT jsonb_build_object(
    'apiVersion', state.api_version,
    'schemaRevision', state.schema_revision,
    'compatibleFrom', COALESCE(state.compatible_from, state.schema_revision),
    'deploymentId', state.deployment_id,
    'memoryChunking', jsonb_build_object(
      'revision', 'lore-memory-chunking-v2',
      'maximumCharacters', 1200,
      'overlapCharacters', 0
    ),
    'features', jsonb_build_object(
      'idempotency', true,
      'optimisticConcurrency', true,
      'transactionalOutbox', true,
      'workspacePortability', true,
      'embeddingGenerations', true,
      'cursorPagination', true,
      'memoryProposals', true,
      'observationEvidence', true,
      'codeIndex', true,
      'codeDependencies', true,
      'codeEvidence', true,
      'memoryLinks', true,
      'memoryTitles', true,
      'memoryGlosses', true
    ),
    'limits', jsonb_build_object(
      'memoryContentRecommendedCharacters', 8000,
      'memoryContentMaximumCharacters', 32000,
      'memoryMaximumChunks', 64,
      'memoryTitleCharacters', 256,
      'memoryGlossCharacters', 512,
      'workspaceArchiveMemories', 10000,
      'workspaceArchiveLinks', 50000,
      'memoryProposalEvidence', 50,
      'memoryProposalList', 100,
      'memoryProposalPending', 100,
      'memoryProposalRetentionSeconds', 2592000,
      'episodeObservations', 100,
      'episodeContentCharacters', 1000000,
      'episodeMetadataCharacters', 1000000,
      'observationContentCharacters', 100000,
      'observationBatchRead', 50,
      'codeIndexFiles', 20000,
      'codeIndexSourceBytes', 134217728,
      'codeIndexArtifacts', 100000,
      'codeDependencyResults', 200,
      'codeSearchResults', 100,
      'memoryLinkMetadataCharacters', 1000,
      'memoryLinkKindsPerPair', 16,
      'memoryLinksPerSource', 1000,
      'memoryLinksPerTarget', 1000,
      'memoryLinksPerOwner', 50000,
      'memoryLinkList', 100,
      'graphLinks', 40000
    ),
    'activeEmbeddingGeneration', (
      SELECT jsonb_build_object(
        'provider', generation.embedding_provider,
        'model', generation.embedding_model,
        'dimensions', generation.embedding_dimensions,
        'revision', generation.embedding_revision
      )
      FROM embedding_generations generation
      WHERE generation.status = 'active'
    )
  )
  FROM lore_system_state state
  WHERE state.singleton
$$;

UPDATE public.lore_system_state
SET schema_revision = 15, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
