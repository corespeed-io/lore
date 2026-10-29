-- migrate:up
-- Schema revision 21: the once-per-statement Workspace read check of 0004, applied
-- to the read policies 0004 left alone.
--
-- Each policy below called lore.can_read_memory or lore.can_read_memory_proposal,
-- on the row or on a joined parent, for every row. Those functions inline,
-- but each calls lore.is_active_member (or lore.agent_has_access for an Agent), a
-- SECURITY DEFINER function that cannot inline, so the Membership or grant lookup
-- ran once per row, and again for each parent row a nested policy read. Every one
-- of them compares the row's Workspace with lore.current_workspace_id(), so the
-- lookup depends only on the session and runs once as an InitPlan, as in 0004:
--
--   lore.can_read_memory(w, owner, scope)
--     = w = lore.current_workspace_id()
--       AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
--       AND (scope = 'shared' OR owner = lore.current_user_id())
--   lore.can_read_memory_proposal(w, owner)
--     = w = lore.current_workspace_id() AND owner = lore.current_user_id()
--       AND (SELECT lore.current_agent_id() IS NULL
--                   AND lore.is_active_member(lore.current_workspace_id()))
--
-- Semantics are unchanged: shared rows need an active Membership or an active read
-- grant of an active Agent whose owner is an active member; private rows also need
-- the owner User; Proposals stay owner-private and human-only; revoked Memberships
-- and grants deny; with no Actor context every comparison is NULL and nothing is
-- visible. tests/server/read-policy-equivalence.test.ts compares each new policy
-- with the old expression for Users, Agents, and revoked access.
--
-- observations_select and memory_proposal_observation_evidence_select call nothing
-- per row themselves; they read through the episodes and memory_proposals policies,
-- which become cheap here. Policies on small tables (memberships, workspaces,
-- users, grants, imports, evaluations) are left as they are.
--
-- compatible_from stays 9: an older instance sees exactly the rows it saw. Each
-- ALTER POLICY takes ACCESS EXCLUSIVE on its table for a catalog change only, and
-- lock_timeout keeps a busy deploy from queueing behind a long transaction; a
-- rerun repeats the whole file.
SET LOCAL lock_timeout = '5s';

ALTER POLICY episodes_select ON public.episodes USING (
  (workspace_id = lore.current_workspace_id())
  AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
  AND ((scope = 'shared'::public.memory_scope) OR (owner_user_id = lore.current_user_id()))
);

ALTER POLICY episode_evidence_chunks_select ON public.episode_evidence_chunks USING (
  (workspace_id = lore.current_workspace_id())
  AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
  AND (EXISTS (
    SELECT 1
    FROM public.episodes episode
    WHERE episode.id = episode_evidence_chunks.episode_id
      AND episode.workspace_id = episode_evidence_chunks.workspace_id
      AND ((episode.scope = 'shared'::public.memory_scope) OR (episode.owner_user_id = lore.current_user_id()))
  ))
);

ALTER POLICY episode_evidence_chunk_embeddings_select ON public.episode_evidence_chunk_embeddings USING (
  (workspace_id = lore.current_workspace_id())
  AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
  AND (EXISTS (
    SELECT 1
    FROM public.episode_evidence_chunks chunk
    JOIN public.episodes episode
      ON episode.id = chunk.episode_id
     AND episode.workspace_id = chunk.workspace_id
    JOIN public.embedding_generations generation
      ON generation.id = episode_evidence_chunk_embeddings.generation_id
    WHERE chunk.id = episode_evidence_chunk_embeddings.chunk_id
      AND chunk.workspace_id = episode_evidence_chunk_embeddings.workspace_id
      AND generation.status = ANY (ARRAY['active'::public.embedding_generation_status, 'retiring'::public.embedding_generation_status])
      AND ((episode.scope = 'shared'::public.memory_scope) OR (episode.owner_user_id = lore.current_user_id()))
  ))
);

ALTER POLICY memory_events_select ON public.memory_events USING (
  (workspace_id = lore.current_workspace_id())
  AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
  AND (
    (
      (resource_type = 'memory'::text)
      AND (
        (EXISTS (
          SELECT 1
          FROM public.memories memory
          WHERE memory.workspace_id = memory_events.workspace_id
            AND memory.id = memory_events.resource_id
            AND ((memory.scope = 'shared'::public.memory_scope) OR (memory.owner_user_id = lore.current_user_id()))
        ))
        OR (
          (event_type = 'memory.deleted'::text)
          AND ((memory_scope = 'shared'::public.memory_scope) OR (owner_user_id = lore.current_user_id()))
        )
      )
    )
    OR (
      (resource_type = 'memory_link'::text)
      AND (EXISTS (
        SELECT 1
        FROM public.memories source_memory
        JOIN public.memories target_memory
          ON target_memory.workspace_id = source_memory.workspace_id
         AND target_memory.id = memory_events.related_memory_id
        WHERE source_memory.workspace_id = memory_events.workspace_id
          AND source_memory.id = memory_events.source_memory_id
          AND ((source_memory.scope = 'shared'::public.memory_scope) OR (source_memory.owner_user_id = lore.current_user_id()))
          AND ((target_memory.scope = 'shared'::public.memory_scope) OR (target_memory.owner_user_id = lore.current_user_id()))
      ))
    )
  )
);

ALTER POLICY memory_import_provenance_select ON public.memory_import_provenance USING (
  (workspace_id = lore.current_workspace_id())
  AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
  AND (EXISTS (
    SELECT 1
    FROM public.memories memory
    WHERE memory.workspace_id = memory_import_provenance.workspace_id
      AND memory.id = memory_import_provenance.memory_id
      AND ((memory.scope = 'shared'::public.memory_scope) OR (memory.owner_user_id = lore.current_user_id()))
  ))
);

ALTER POLICY memory_code_evidence_select ON public.memory_code_evidence USING (
  (workspace_id = lore.current_workspace_id())
  AND (SELECT lore.can_read_code_index(lore.current_workspace_id()))
  AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
  AND (EXISTS (
    SELECT 1
    FROM public.memories memory
    WHERE memory.workspace_id = memory_code_evidence.workspace_id
      AND memory.id = memory_code_evidence.memory_id
      AND ((memory.scope = 'shared'::public.memory_scope) OR (memory.owner_user_id = lore.current_user_id()))
  ))
);

ALTER POLICY memory_observation_evidence_select ON public.memory_observation_evidence USING (
  (workspace_id = lore.current_workspace_id())
  AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
  AND (EXISTS (
    SELECT 1
    FROM public.memories memory
    WHERE memory.workspace_id = memory_observation_evidence.workspace_id
      AND memory.id = memory_observation_evidence.memory_id
      AND ((memory.scope = 'shared'::public.memory_scope) OR (memory.owner_user_id = lore.current_user_id()))
  ))
  AND (EXISTS (
    SELECT 1
    FROM public.observations observation
    JOIN public.episodes episode
      ON episode.workspace_id = observation.workspace_id
     AND episode.id = observation.episode_id
    WHERE observation.workspace_id = memory_observation_evidence.workspace_id
      AND observation.id = memory_observation_evidence.observation_id
      AND ((episode.scope = 'shared'::public.memory_scope) OR (episode.owner_user_id = lore.current_user_id()))
  ))
);

ALTER POLICY memory_proposals_select ON public.memory_proposals USING (
  (workspace_id = lore.current_workspace_id())
  AND (owner_user_id = lore.current_user_id())
  AND (SELECT (lore.current_agent_id() IS NULL) AND lore.is_active_member(lore.current_workspace_id()))
  AND (expires_at > now())
);

ALTER POLICY memory_proposal_evidence_select ON public.memory_proposal_evidence USING (
  (EXISTS (
    SELECT 1
    FROM public.memory_proposals proposal
    WHERE proposal.id = memory_proposal_evidence.proposal_id
      AND proposal.workspace_id = memory_proposal_evidence.workspace_id
  ))
  AND (workspace_id = lore.current_workspace_id())
  AND (SELECT lore.can_read_workspace(lore.current_workspace_id()))
  AND (EXISTS (
    SELECT 1
    FROM public.memories memory
    WHERE memory.id = memory_proposal_evidence.memory_id
      AND memory.workspace_id = memory_proposal_evidence.workspace_id
      AND ((memory.scope = 'shared'::public.memory_scope) OR (memory.owner_user_id = lore.current_user_id()))
  ))
);

ALTER POLICY memory_proposal_code_evidence_select ON public.memory_proposal_code_evidence USING (
  (EXISTS (
    SELECT 1
    FROM public.memory_proposals proposal
    WHERE proposal.id = memory_proposal_code_evidence.proposal_id
      AND proposal.workspace_id = memory_proposal_code_evidence.workspace_id
      AND proposal.workspace_id = lore.current_workspace_id()
      AND proposal.owner_user_id = lore.current_user_id()
      AND (SELECT (lore.current_agent_id() IS NULL) AND lore.is_active_member(lore.current_workspace_id()))
      AND proposal.expires_at > now()
  ))
);

UPDATE public.lore_system_state
SET schema_revision = 21, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
