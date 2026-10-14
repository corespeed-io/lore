-- migrate:up
-- Schema revision 14: Memory Observation Evidence. A canonical Memory may cite the
-- immutable Observations it came from, so an agent can read the original text when
-- the Memory lacks a detail. A row holds ids only and never copies Observation
-- content. Each side keeps its own RLS: a row is visible only while its Memory and
-- its Observation's Episode are both visible, and forgetting either side deletes it.
--
-- compatible_from stays 9: the migration only adds a table, its index, policies,
-- and grants. An older application never names them, and a Memory or Episode it
-- forgets removes their rows through the foreign keys.
--
-- Each foreign key takes SHARE ROW EXCLUSIVE on the table it references until
-- commit, which blocks that table's writes. The new table is empty, so this lasts
-- milliseconds, and lock_timeout keeps a busy deploy from queueing behind it. The
-- keys are added in the order request paths lock these tables (Agent deletion locks
-- agents before memories), so the migration cannot deadlock with them.
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.memory_observation_evidence (
    workspace_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    observation_id uuid NOT NULL,
    created_by_user_id uuid NOT NULL,
    created_by_agent_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_observation_evidence_pkey PRIMARY KEY (memory_id, observation_id)
);
ALTER TABLE public.memory_observation_evidence
  ADD CONSTRAINT memory_observation_evidence_created_by_agent_id_fkey
  FOREIGN KEY (created_by_agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;
ALTER TABLE public.memory_observation_evidence
  ADD CONSTRAINT memory_observation_evidence_created_by_user_id_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.memory_observation_evidence
  ADD CONSTRAINT memory_observation_evidence_observation_fkey
  FOREIGN KEY (workspace_id, observation_id) REFERENCES public.observations(workspace_id, id)
  ON DELETE CASCADE;
ALTER TABLE public.memory_observation_evidence
  ADD CONSTRAINT memory_observation_evidence_memory_fkey
  FOREIGN KEY (workspace_id, memory_id) REFERENCES public.memories(workspace_id, id)
  ON DELETE CASCADE;
COMMENT ON TABLE public.memory_observation_evidence IS 'Citations from canonical Memory to the immutable Observations it came from. Ids only; Observation content stays in observations.';

-- Forgetting an Episode cascades here by Observation; the primary key serves the
-- Memory side.
CREATE INDEX memory_observation_evidence_observation_idx
  ON public.memory_observation_evidence USING btree (workspace_id, observation_id);

ALTER TABLE public.memory_observation_evidence ENABLE ROW LEVEL SECURITY;

-- Visible only while both the Memory and the Observation's Episode are visible, so
-- a shared Memory never reveals a private Observation's id or existence.
CREATE POLICY memory_observation_evidence_select ON public.memory_observation_evidence
  FOR SELECT TO lore_app USING (
    workspace_id = lore.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM public.memories memory
      WHERE memory.workspace_id = memory_observation_evidence.workspace_id
        AND memory.id = memory_observation_evidence.memory_id
        AND lore.can_read_memory(memory.workspace_id, memory.owner_user_id, memory.scope)
    )
    AND EXISTS (
      SELECT 1
      FROM public.observations observation
      JOIN public.episodes episode
        ON episode.workspace_id = observation.workspace_id
       AND episode.id = observation.episode_id
      WHERE observation.workspace_id = memory_observation_evidence.workspace_id
        AND observation.id = memory_observation_evidence.observation_id
        AND lore.can_read_memory(episode.workspace_id, episode.owner_user_id, episode.scope)
    )
  );

-- Citing needs write authority over the Memory and sight of the Observation, and
-- records the Actor that cited it.
CREATE POLICY memory_observation_evidence_insert ON public.memory_observation_evidence
  FOR INSERT TO lore_app WITH CHECK (
    workspace_id = lore.current_workspace_id()
    AND created_by_user_id = lore.current_user_id()
    AND NOT (created_by_agent_id IS DISTINCT FROM lore.current_agent_id())
    AND EXISTS (
      SELECT 1
      FROM public.memories memory
      WHERE memory.workspace_id = memory_observation_evidence.workspace_id
        AND memory.id = memory_observation_evidence.memory_id
        AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)
    )
    AND EXISTS (
      SELECT 1
      FROM public.observations observation
      JOIN public.episodes episode
        ON episode.workspace_id = observation.workspace_id
       AND episode.id = observation.episode_id
      WHERE observation.workspace_id = memory_observation_evidence.workspace_id
        AND observation.id = memory_observation_evidence.observation_id
        AND lore.can_read_memory(episode.workspace_id, episode.owner_user_id, episode.scope)
    )
  );

-- Removing a citation needs write authority over the Memory; the SELECT policy
-- also applies, so a citation the Actor cannot see cannot be removed.
CREATE POLICY memory_observation_evidence_delete ON public.memory_observation_evidence
  FOR DELETE TO lore_app USING (
    workspace_id = lore.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM public.memories memory
      WHERE memory.workspace_id = memory_observation_evidence.workspace_id
        AND memory.id = memory_observation_evidence.memory_id
        AND lore.can_write_memory(memory.workspace_id, memory.owner_user_id)
    )
  );

-- A citation is never rewritten: it is inserted or deleted.
GRANT SELECT, INSERT, DELETE ON TABLE public.memory_observation_evidence TO lore_app;

UPDATE public.lore_system_state
SET schema_revision = 14, compatible_from = 9, updated_at = now()
WHERE singleton;
-- migrate:down
