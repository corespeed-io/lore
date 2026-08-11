DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM lore_system_state
    WHERE singleton AND schema_revision = 8
  ) THEN
    RAISE EXCEPTION 'Expected Lore schema revision 8 before migration 0009';
  END IF;
END
$$;

CREATE TYPE episode_kind AS ENUM ('conversation', 'workflow', 'document', 'event');
CREATE TYPE observation_kind AS ENUM (
  'message',
  'tool_call',
  'tool_result',
  'document_fragment',
  'event'
);

CREATE TABLE episodes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recorded_by_actor_kind text NOT NULL CHECK (recorded_by_actor_kind IN ('human', 'agent')),
  recorded_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  kind episode_kind NOT NULL,
  scope memory_scope NOT NULL DEFAULT 'private',
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CHECK (ended_at >= started_at),
  CHECK (
    recorded_by_actor_kind = 'agent'
    OR recorded_by_agent_id IS NULL
  )
);

CREATE TABLE observations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind observation_kind NOT NULL,
  observed_at timestamptz NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  content text NOT NULL CHECK (
    btrim(content) <> ''
    AND length(content) <= 100000
  ),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (episode_id, ordinal),
  FOREIGN KEY (workspace_id, episode_id)
    REFERENCES episodes(workspace_id, id)
    ON DELETE CASCADE
);

CREATE TABLE memory_proposal_observation_evidence (
  workspace_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  observation_id uuid REFERENCES observations(id) ON DELETE SET NULL,
  observation_reference_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (proposal_id, observation_reference_id),
  UNIQUE (proposal_id, ordinal),
  FOREIGN KEY (workspace_id, proposal_id)
    REFERENCES memory_proposals(workspace_id, id)
    ON DELETE CASCADE,
  CHECK (observation_id IS NULL OR observation_id = observation_reference_id)
);

CREATE INDEX episodes_owner_created_idx
  ON episodes (workspace_id, owner_user_id, created_at DESC, id);
CREATE INDEX episodes_workspace_created_idx
  ON episodes (workspace_id, created_at DESC, id DESC);
CREATE INDEX observations_episode_idx
  ON observations (workspace_id, episode_id, ordinal);
CREATE INDEX memory_proposal_observation_evidence_observation_idx
  ON memory_proposal_observation_evidence (workspace_id, observation_id, proposal_id);

CREATE FUNCTION lore.record_episode(
  target_workspace_id uuid,
  target_owner_user_id uuid,
  target_actor_kind text,
  target_agent_id uuid,
  target_kind episode_kind,
  target_scope memory_scope,
  target_started_at timestamptz,
  target_ended_at timestamptz,
  target_observations jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  episode_identifier uuid := gen_random_uuid();
  observation_record record;
  observation_identifier uuid;
  observation_metadata jsonb;
  observation_timestamp timestamptz;
  total_characters bigint;
  total_metadata_characters bigint;
BEGIN
  IF NOT lore.can_write_memory(target_workspace_id, target_owner_user_id)
    OR target_actor_kind IS DISTINCT FROM (CASE
      WHEN lore.current_agent_id() IS NULL THEN 'human'
      ELSE 'agent'
    END)
    OR target_agent_id IS DISTINCT FROM lore.current_agent_id()
  THEN
    RAISE EXCEPTION 'Actor cannot record this Episode'
      USING ERRCODE = '42501';
  END IF;

  IF target_ended_at < target_started_at
    OR jsonb_typeof(target_observations) IS DISTINCT FROM 'array'
    OR jsonb_array_length(target_observations) NOT BETWEEN 1 AND 100
  THEN
    RAISE EXCEPTION 'Episode observations are invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    sum(length(observation.value->>'content')),
    sum(length((observation.value->'metadata')::text))
  INTO total_characters, total_metadata_characters
  FROM jsonb_array_elements(target_observations) observation(value);
  IF total_characters IS NULL OR total_characters > 1000000 THEN
    RAISE EXCEPTION 'Episode observation content exceeds its bound'
      USING ERRCODE = '22023';
  END IF;
  IF total_metadata_characters IS NULL OR total_metadata_characters > 1000000 THEN
    RAISE EXCEPTION 'Episode observation metadata exceeds its bound'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.episodes (
    id, workspace_id, owner_user_id, recorded_by_actor_kind,
    recorded_by_agent_id, kind, scope, started_at, ended_at
  ) VALUES (
    episode_identifier, target_workspace_id, target_owner_user_id, target_actor_kind,
    target_agent_id, target_kind, target_scope, target_started_at, target_ended_at
  );

  FOR observation_record IN
    SELECT value, ordinal - 1 AS ordinal
    FROM jsonb_array_elements(target_observations) WITH ORDINALITY item(value, ordinal)
    ORDER BY ordinal
  LOOP
    observation_identifier := gen_random_uuid();
    observation_metadata := observation_record.value->'metadata';
    observation_timestamp := (observation_record.value->>'observedAt')::timestamptz;
    IF observation_timestamp < target_started_at
      OR observation_timestamp > target_ended_at
      OR jsonb_typeof(observation_metadata) IS DISTINCT FROM 'object'
      OR length(observation_metadata::text) > 100000
    THEN
      RAISE EXCEPTION 'Observation is outside its Episode envelope'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.observations (
      id, workspace_id, episode_id, ordinal, kind, observed_at,
      payload_sha256, content, metadata
    ) VALUES (
      observation_identifier,
      target_workspace_id,
      episode_identifier,
      observation_record.ordinal,
      (observation_record.value->>'kind')::observation_kind,
      observation_timestamp,
      encode(
        sha256(
          convert_to(
            jsonb_build_object(
              'kind', observation_record.value->>'kind',
              'content', observation_record.value->>'content',
              'metadata', observation_metadata,
              'observedAt', to_char(
                observation_timestamp AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              )
            )::text,
            'UTF8'
          )
        ),
        'hex'
      ),
      observation_record.value->>'content',
      observation_metadata
    );
  END LOOP;

  RETURN episode_identifier;
END
$$;

CREATE FUNCTION lore.scrub_deleted_episode_replay()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.request_idempotency_records replay
  WHERE replay.workspace_id = OLD.workspace_id
    AND replay.response_body #>> '{episode,id}' = OLD.id::text;
  RETURN OLD;
END
$$;

CREATE FUNCTION lore.lock_reviewable_proposal_observations(
  target_workspace_id uuid,
  target_proposal_id uuid
)
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT observation.id
  FROM public.memory_proposal_observation_evidence evidence
  JOIN public.memory_proposals proposal
    ON proposal.workspace_id = evidence.workspace_id
   AND proposal.id = evidence.proposal_id
  JOIN public.observations observation
    ON observation.id = evidence.observation_id
  JOIN public.episodes episode
    ON episode.workspace_id = observation.workspace_id
   AND episode.id = observation.episode_id
  WHERE evidence.workspace_id = target_workspace_id
    AND evidence.proposal_id = target_proposal_id
    AND target_workspace_id = lore.current_workspace_id()
    AND lore.can_review_memory_proposal(proposal.workspace_id, proposal.owner_user_id)
    AND lore.can_read_memory(episode.workspace_id, episode.owner_user_id, episode.scope)
  FOR KEY SHARE OF observation
$$;

CREATE TRIGGER episodes_scrub_idempotency
AFTER DELETE ON episodes
FOR EACH ROW
EXECUTE FUNCTION lore.scrub_deleted_episode_replay();

ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_proposal_observation_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY episodes_select ON episodes
  FOR SELECT
  USING (lore.can_read_memory(workspace_id, owner_user_id, scope));

CREATE POLICY episodes_delete ON episodes
  FOR DELETE
  USING (lore.can_write_memory(workspace_id, owner_user_id));

CREATE POLICY observations_select ON observations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM episodes episode
      WHERE episode.id = observations.episode_id
        AND episode.workspace_id = observations.workspace_id
    )
  );

CREATE POLICY memory_proposal_observation_evidence_select
  ON memory_proposal_observation_evidence
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM memory_proposals proposal
      WHERE proposal.id = memory_proposal_observation_evidence.proposal_id
        AND proposal.workspace_id = memory_proposal_observation_evidence.workspace_id
    )
  );

CREATE POLICY memory_proposal_observation_evidence_insert
  ON memory_proposal_observation_evidence
  FOR INSERT
  WITH CHECK (
    lore.can_append_memory_proposal_evidence(
      memory_proposal_observation_evidence.workspace_id,
      memory_proposal_observation_evidence.proposal_id
    )
    AND memory_proposal_observation_evidence.observation_id =
      memory_proposal_observation_evidence.observation_reference_id
    AND EXISTS (
      SELECT 1
      FROM observations observation
      WHERE observation.id = memory_proposal_observation_evidence.observation_id
        AND observation.workspace_id = memory_proposal_observation_evidence.workspace_id
    )
  );

REVOKE ALL ON FUNCTION lore.record_episode(
  uuid, uuid, text, uuid, episode_kind, memory_scope,
  timestamptz, timestamptz, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.scrub_deleted_episode_replay() FROM PUBLIC;
REVOKE ALL ON FUNCTION lore.lock_reviewable_proposal_observations(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lore.record_episode(
  uuid, uuid, text, uuid, episode_kind, memory_scope,
  timestamptz, timestamptz, jsonb
) TO lore_app;
GRANT EXECUTE ON FUNCTION lore.lock_reviewable_proposal_observations(uuid, uuid) TO lore_app;
GRANT SELECT, DELETE ON episodes TO lore_app;
GRANT SELECT ON observations TO lore_app;
GRANT SELECT, INSERT ON memory_proposal_observation_evidence TO lore_app;

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
      'memoryProposals', true,
      'observationEvidence', true
    ),
    'limits', jsonb_build_object(
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
      'observationBatchRead', 50
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

CREATE OR REPLACE FUNCTION lore.purge_expired_portable_core_records()
RETURNS TABLE (idempotency_records bigint, memory_event_records bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  idempotency_count bigint;
  event_count bigint;
BEGIN
  DELETE FROM public.memory_proposals WHERE expires_at <= now();
  DELETE FROM public.request_idempotency_records WHERE expires_at <= now();
  GET DIAGNOSTICS idempotency_count = ROW_COUNT;
  DELETE FROM public.memory_events WHERE expires_at <= now();
  GET DIAGNOSTICS event_count = ROW_COUNT;
  RETURN QUERY SELECT idempotency_count, event_count;
END
$$;

COMMENT ON TABLE episodes IS
  'Immutable evidence envelopes. Episodes group ordered Observations but are not canonical Memory.';
COMMENT ON TABLE observations IS
  'Immutable, durable evidence records. Content remains until its Episode is explicitly forgotten.';
COMMENT ON TABLE memory_proposal_observation_evidence IS
  'Owner-private Proposal evidence references. Explicit forget nulls the live pointer but retains the content-free cited id until Proposal expiry.';

DO $$
BEGIN
  UPDATE lore_system_state
  SET schema_revision = 9, updated_at = now()
  WHERE singleton AND schema_revision = 8;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected Lore schema revision 8 before migration 0009';
  END IF;
END
$$;
