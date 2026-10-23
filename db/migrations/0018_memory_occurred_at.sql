-- migrate:up
-- Schema revision 18: when a Memory's event happened. A Memory may carry occurred_at,
-- the time the event or statement it records happened, as its writer states it. It is
-- not when Lore recorded the Memory (created_at) or last changed it (updated_at): a
-- Memory imported from an old conversation, or written days after a meeting, keeps
-- the time of that conversation or meeting. It is optional, may be changed or
-- removed, and is never inferred from content. This revision adds the column and its
-- rule, the proposed time on Memory Proposals, the column in the mutation outbox and
-- the review guard, and the feature in capabilities. 0019 validates the new CHECKs.
--
-- The rule (memories_occurred_at_check, restated by validateMemoryOccurredAt in
-- lore-core): an instant in the years 0001 through 9999 UTC, so its RFC 3339 form
-- always has a four-digit year. The CHECKs start NOT VALID, which skips the table scan
-- while this migration holds ACCESS EXCLUSIVE; every new or changed row is checked at
-- once, and the new column holds no other value yet.
--
-- compatible_from stays 9. An application of revision 9 through 17 never names the
-- new columns: it writes none, its updates keep occurred_at, and its Proposal calls
-- reach the older lore.submit_memory_proposal functions, kept as they are. The review
-- guard refuses its acceptance of a Proposal that sets occurred_at, rather than let it
-- write the Memory without it; the window lasts a rolling deploy.
--
-- It takes ACCESS EXCLUSIVE on memories, then memory_proposals, then
-- lore_system_state. Adding a nullable column, or a NOT NULL one with a constant
-- default, is catalog-only, so each lock lasts milliseconds once granted. Request
-- paths lock a Memory before its Proposals, the same order, so this cannot deadlock
-- with them, and lock_timeout keeps a busy deploy from queueing behind a long
-- transaction. A timeout fails the migration retryably and records nothing.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.memories
  ADD COLUMN occurred_at timestamp with time zone,
  ADD CONSTRAINT memories_occurred_at_check CHECK (
    occurred_at IS NULL
    OR (
      occurred_at >= '0001-01-01 00:00:00+00'::timestamp with time zone
      AND occurred_at < '10000-01-01 00:00:00+00'::timestamp with time zone
    )
  ) NOT VALID;
COMMENT ON COLUMN public.memories.occurred_at IS 'Optional time the event or statement a Memory records happened, as its writer states it; not when Lore recorded it.';

-- A Proposal states its time as a change: the proposed value, NULL unless it changes,
-- and whether it changes. A create sets it (changes_occurred_at true, NULL for none).
-- memory_proposals_check1 is rebuilt so an update that changes only the time is a
-- Proposal.
ALTER TABLE public.memory_proposals
  ADD COLUMN proposed_occurred_at timestamp with time zone,
  ADD COLUMN changes_occurred_at boolean DEFAULT false NOT NULL,
  ADD CONSTRAINT memory_proposals_proposed_occurred_at_check CHECK (
    proposed_occurred_at IS NULL
    OR (
      proposed_occurred_at >= '0001-01-01 00:00:00+00'::timestamp with time zone
      AND proposed_occurred_at < '10000-01-01 00:00:00+00'::timestamp with time zone
    )
  ) NOT VALID,
  ADD CONSTRAINT memory_proposals_occurred_at_change_check CHECK (
    changes_occurred_at OR proposed_occurred_at IS NULL
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
      AND (
        changes_content
        OR changes_scope
        OR changes_metadata
        OR changes_title
        OR changes_gloss
        OR changes_occurred_at
      )
    )
  ) NOT VALID;
COMMENT ON COLUMN public.memory_proposals.proposed_occurred_at IS 'The proposed Memory occurred_at, or NULL for none; meaningful only when changes_occurred_at.';

-- The outbox names occurred_at among the changed fields. Otherwise the body is 0015's,
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
    changed := ARRAY['content', 'metadata', 'scope', 'title', 'gloss', 'occurred_at'];
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
    IF OLD.occurred_at IS DISTINCT FROM NEW.occurred_at THEN changed := array_append(changed, 'occurred_at'); END IF;
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
    OLD.version, ARRAY['content', 'metadata', 'scope', 'title', 'gloss', 'occurred_at'],
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

-- The submission with occurred_at. The 13- and 17-argument functions stay for
-- applications of revision 17 and older, which call them during a rolling deploy; they
-- propose no time (changes_occurred_at false, proposed_occurred_at NULL). This one
-- takes the same checks and adds the time and whether the Proposal changes it.
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
    target_changes_gloss boolean,
    target_occurred_at timestamp with time zone,
    target_changes_occurred_at boolean
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
    proposed_occurred_at, changes_content, changes_scope, changes_metadata, changes_title,
    changes_gloss, changes_occurred_at
  ) VALUES (
    gen_random_uuid(), target_workspace_id, target_owner_user_id, target_actor_kind,
    target_agent_id, target_kind, target_memory_id, target_base_memory_version,
    target_content, target_scope, target_metadata, target_title, target_gloss,
    target_occurred_at, target_changes_content, target_changes_scope, target_changes_metadata,
    target_changes_title, target_changes_gloss, target_changes_occurred_at
  )
  RETURNING public.memory_proposals.*;
END
$$;
COMMENT ON FUNCTION lore.submit_memory_proposal(uuid, uuid, text, uuid, public.memory_proposal_kind, uuid, integer, text, public.memory_scope, jsonb, boolean, boolean, boolean, text, boolean, text, boolean, timestamp with time zone, boolean) IS 'Submits a Memory Proposal, title, gloss, and occurred_at included, after the same write-authority and Actor checks as the 13-argument form.';
REVOKE ALL ON FUNCTION lore.submit_memory_proposal(uuid, uuid, text, uuid, public.memory_proposal_kind, uuid, integer, text, public.memory_scope, jsonb, boolean, boolean, boolean, text, boolean, text, boolean, timestamp with time zone, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.submit_memory_proposal(uuid, uuid, text, uuid, public.memory_proposal_kind, uuid, integer, text, public.memory_scope, jsonb, boolean, boolean, boolean, text, boolean, text, boolean, timestamp with time zone, boolean) TO lore_app;

-- The review guard keeps the occurred_at columns as immutable as the others, and an
-- accepted receipt must match the Memory's occurred_at as it matches the title: a
-- create's always (NULL when none was proposed), an update's only when the Proposal
-- changes it. An application of revision 17 accepting a Proposal that sets it would
-- write the Memory without it, so this check refuses that acceptance rather than let
-- it be lost; the window lasts a rolling deploy.
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
      AND NEW.proposed_occurred_at IS NOT DISTINCT FROM OLD.proposed_occurred_at
      AND NEW.changes_content IS NOT DISTINCT FROM OLD.changes_content
      AND NEW.changes_scope IS NOT DISTINCT FROM OLD.changes_scope
      AND NEW.changes_metadata IS NOT DISTINCT FROM OLD.changes_metadata
      AND NEW.changes_title IS NOT DISTINCT FROM OLD.changes_title
      AND NEW.changes_gloss IS NOT DISTINCT FROM OLD.changes_gloss
      AND NEW.changes_occurred_at IS NOT DISTINCT FROM OLD.changes_occurred_at
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
    OR NEW.proposed_occurred_at IS DISTINCT FROM OLD.proposed_occurred_at
    OR NEW.changes_content IS DISTINCT FROM OLD.changes_content
    OR NEW.changes_scope IS DISTINCT FROM OLD.changes_scope
    OR NEW.changes_metadata IS DISTINCT FROM OLD.changes_metadata
    OR NEW.changes_title IS DISTINCT FROM OLD.changes_title
    OR NEW.changes_gloss IS DISTINCT FROM OLD.changes_gloss
    OR NEW.changes_occurred_at IS DISTINCT FROM OLD.changes_occurred_at
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
          AND (
            NOT OLD.changes_occurred_at
            OR memory.occurred_at IS NOT DISTINCT FROM OLD.proposed_occurred_at
          )
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
        AND memory.occurred_at IS NOT DISTINCT FROM OLD.proposed_occurred_at
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

-- 0015's body plus the memoryOccurredAt feature, which DEPLOYMENT_FEATURES publishes
-- from this revision on.
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
      'memoryGlosses', true,
      'memoryOccurredAt', true
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
SET schema_revision = 18, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
