CREATE TYPE memory_proposal_kind AS ENUM ('create', 'update');
CREATE TYPE memory_proposal_status AS ENUM ('pending', 'accepted', 'rejected');

CREATE TABLE memory_proposals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposed_by_actor_kind text NOT NULL CHECK (proposed_by_actor_kind IN ('human', 'agent')),
  proposed_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  kind memory_proposal_kind NOT NULL,
  target_memory_id uuid,
  base_memory_version integer,
  proposed_content text NOT NULL CHECK (btrim(proposed_content) <> ''),
  proposed_scope memory_scope NOT NULL,
  proposed_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(proposed_metadata) = 'object'),
  changes_content boolean NOT NULL,
  changes_scope boolean NOT NULL,
  changes_metadata boolean NOT NULL,
  status memory_proposal_status NOT NULL DEFAULT 'pending',
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_memory_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE (workspace_id, id),
  CHECK (
    proposed_by_actor_kind = 'agent'
    OR proposed_by_agent_id IS NULL
  ),
  CHECK (
    (kind = 'create'
      AND target_memory_id IS NULL
      AND base_memory_version IS NULL
      AND changes_content
      AND changes_scope
      AND changes_metadata)
    OR
    (kind = 'update'
      AND target_memory_id IS NOT NULL
      AND base_memory_version > 0
      AND (changes_content OR changes_scope OR changes_metadata))
  ),
  CHECK (
    (status = 'pending'
      AND reviewed_by_user_id IS NULL
      AND accepted_memory_id IS NULL
      AND reviewed_at IS NULL)
    OR
    (status = 'accepted'
      AND reviewed_by_user_id IS NOT NULL
      AND accepted_memory_id IS NOT NULL
      AND reviewed_at IS NOT NULL)
    OR
    (status = 'rejected'
      AND reviewed_by_user_id IS NOT NULL
      AND accepted_memory_id IS NULL
      AND reviewed_at IS NOT NULL)
  )
);

CREATE TABLE memory_proposal_evidence (
  workspace_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (proposal_id, memory_id),
  UNIQUE (proposal_id, ordinal),
  FOREIGN KEY (workspace_id, proposal_id)
    REFERENCES memory_proposals(workspace_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, memory_id)
    REFERENCES memories(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX memory_proposals_owner_status_idx
  ON memory_proposals (workspace_id, owner_user_id, status, created_at DESC, id);
CREATE INDEX memory_proposal_evidence_memory_idx
  ON memory_proposal_evidence (workspace_id, memory_id, proposal_id);

CREATE FUNCTION lore.can_read_memory_proposal(
  target_workspace_id uuid,
  target_owner_user_id uuid,
  target_proposed_by_agent_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT target_workspace_id = lore.current_workspace_id()
    AND target_owner_user_id = lore.current_user_id()
    AND CASE
      WHEN lore.current_agent_id() IS NULL THEN lore.is_active_member(target_workspace_id)
      ELSE target_proposed_by_agent_id = lore.current_agent_id()
        AND lore.agent_has_access(target_workspace_id, 'read')
    END
$$;

CREATE FUNCTION lore.can_review_memory_proposal(
  target_workspace_id uuid,
  target_owner_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT lore.current_agent_id() IS NULL
    AND target_workspace_id = lore.current_workspace_id()
    AND target_owner_user_id = lore.current_user_id()
    AND lore.is_active_member(target_workspace_id)
$$;

CREATE FUNCTION lore.protect_memory_proposal_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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
      AND NEW.changes_content IS NOT DISTINCT FROM OLD.changes_content
      AND NEW.changes_scope IS NOT DISTINCT FROM OLD.changes_scope
      AND NEW.changes_metadata IS NOT DISTINCT FROM OLD.changes_metadata
      AND NEW.status IS NOT DISTINCT FROM OLD.status
      AND NEW.reviewed_by_user_id IS NOT DISTINCT FROM OLD.reviewed_by_user_id
      AND NEW.accepted_memory_id IS NOT DISTINCT FROM OLD.accepted_memory_id
      AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
      AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
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
    OR NEW.changes_content IS DISTINCT FROM OLD.changes_content
    OR NEW.changes_scope IS DISTINCT FROM OLD.changes_scope
    OR NEW.changes_metadata IS DISTINCT FROM OLD.changes_metadata
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Memory Proposal content and identity are immutable'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status <> 'pending'
    OR NEW.status NOT IN ('accepted', 'rejected')
    OR NEW.reviewed_by_user_id IS DISTINCT FROM lore.current_user_id()
    OR NEW.reviewed_at IS NULL
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

CREATE FUNCTION lore.validate_memory_proposal_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
  FROM public.memberships membership
  WHERE membership.workspace_id = NEW.workspace_id
    AND membership.user_id = NEW.owner_user_id
  FOR UPDATE;

  IF (
    SELECT count(*)
    FROM public.memory_proposals proposal
    WHERE proposal.workspace_id = NEW.workspace_id
      AND proposal.owner_user_id = NEW.owner_user_id
      AND proposal.status = 'pending'
  ) >= 100
  THEN
    RAISE EXCEPTION 'Memory Proposal pending limit reached'
      USING ERRCODE = '54000';
  END IF;

  IF NEW.kind = 'update'
    AND NOT EXISTS (
      SELECT 1
      FROM public.memories memory
      WHERE memory.id = NEW.target_memory_id
        AND memory.workspace_id = NEW.workspace_id
        AND memory.owner_user_id = NEW.owner_user_id
    )
  THEN
    RAISE EXCEPTION 'Memory Proposal target must be an owned Memory in this Workspace'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER memory_proposals_validate_target
BEFORE INSERT ON memory_proposals
FOR EACH ROW
EXECUTE FUNCTION lore.validate_memory_proposal_target();

CREATE TRIGGER memory_proposals_protect_review
BEFORE UPDATE ON memory_proposals
FOR EACH ROW
EXECUTE FUNCTION lore.protect_memory_proposal_review();

ALTER TABLE memory_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_proposal_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY memory_proposals_select ON memory_proposals
  FOR SELECT
  USING (
    lore.can_read_memory_proposal(workspace_id, owner_user_id, proposed_by_agent_id)
  );

CREATE POLICY memory_proposals_insert ON memory_proposals
  FOR INSERT
  WITH CHECK (
    lore.can_write_memory(workspace_id, owner_user_id)
    AND proposed_by_actor_kind = CASE
      WHEN lore.current_agent_id() IS NULL THEN 'human'
      ELSE 'agent'
    END
    AND proposed_by_agent_id IS NOT DISTINCT FROM lore.current_agent_id()
    AND status = 'pending'
  );

CREATE POLICY memory_proposals_update ON memory_proposals
  FOR UPDATE
  USING (lore.can_review_memory_proposal(workspace_id, owner_user_id))
  WITH CHECK (lore.can_review_memory_proposal(workspace_id, owner_user_id));

CREATE POLICY memory_proposal_evidence_select ON memory_proposal_evidence
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM memory_proposals proposal
      WHERE proposal.id = memory_proposal_evidence.proposal_id
        AND proposal.workspace_id = memory_proposal_evidence.workspace_id
    )
    AND EXISTS (
      SELECT 1
      FROM memories memory
      WHERE memory.id = memory_proposal_evidence.memory_id
        AND memory.workspace_id = memory_proposal_evidence.workspace_id
        AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)
    )
  );

CREATE POLICY memory_proposal_evidence_insert ON memory_proposal_evidence
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM memory_proposals proposal
      WHERE proposal.id = memory_proposal_evidence.proposal_id
        AND proposal.workspace_id = memory_proposal_evidence.workspace_id
        AND proposal.status = 'pending'
    )
    AND EXISTS (
      SELECT 1
      FROM memories memory
      WHERE memory.id = memory_proposal_evidence.memory_id
        AND memory.workspace_id = memory_proposal_evidence.workspace_id
        AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)
    )
  );

REVOKE ALL ON FUNCTION lore.can_read_memory_proposal(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.can_review_memory_proposal(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.protect_memory_proposal_review() FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.validate_memory_proposal_target() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.can_read_memory_proposal(uuid, uuid, uuid) TO lore_app;
GRANT EXECUTE ON FUNCTION lore.can_review_memory_proposal(uuid, uuid) TO lore_app;
GRANT SELECT, INSERT, UPDATE ON memory_proposals TO lore_app;
GRANT SELECT, INSERT ON memory_proposal_evidence TO lore_app;

CREATE OR REPLACE FUNCTION lore.portable_core_capabilities()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'apiVersion', state.api_version,
    'schemaRevision', state.schema_revision,
    'deploymentId', state.deployment_id,
    'features', jsonb_build_object(
      'idempotency', true,
      'optimisticConcurrency', true,
      'transactionalOutbox', true,
      'workspacePortability', true,
      'embeddingGenerations', true,
      'cursorPagination', true,
      'memoryProposals', true
    ),
    'limits', jsonb_build_object(
      'workspaceArchiveMemories', 10000,
      'workspaceArchiveLinks', 50000,
      'memoryProposalEvidence', 50,
      'memoryProposalList', 100,
      'memoryProposalPending', 100
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

DO $$
BEGIN
  UPDATE lore_system_state
  SET schema_revision = 8, updated_at = now()
  WHERE singleton AND schema_revision = 7;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected Lore schema revision 7 before migration 0008';
  END IF;
END
$$;
