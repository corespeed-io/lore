-- migrate:up
-- Schema revision 6: Memory Links are written after creation. Capabilities
-- advertise the memoryLinks feature and publish the bounds the engine enforces
-- on them: Link metadata size, kinds per directed pair, Links per source, per
-- owner and target, and per owner in a Workspace, the Link list page, and the
-- Graph's Link budget. The function body is otherwise the baseline's; its grants
-- carry over because CREATE OR REPLACE keeps them.
CREATE OR REPLACE FUNCTION lore.portable_core_capabilities() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT jsonb_build_object(
    'apiVersion', state.api_version,
    'schemaRevision', state.schema_revision,
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
      'memoryLinks', true
    ),
    'limits', jsonb_build_object(
      'memoryContentRecommendedCharacters', 8000,
      'memoryContentMaximumCharacters', 32000,
      'memoryMaximumChunks', 64,
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
SET schema_revision = 6, updated_at = now()
WHERE singleton;
-- migrate:down
