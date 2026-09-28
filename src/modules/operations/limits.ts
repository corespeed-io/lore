import {
  MEMORY_CHUNK_MAXIMUM_CHARACTERS,
  MEMORY_CHUNK_OVERLAP_CHARACTERS,
  MEMORY_CHUNKING_REVISION,
  MEMORY_CONTENT_LIMITS,
  MEMORY_GRAPH_LIMITS,
  MEMORY_LINK_LIMITS,
} from "@corespeed/lore-core";
import {
  MAX_EPISODE_CONTENT_CHARACTERS,
  MAX_EPISODE_METADATA_CHARACTERS,
  MAX_EPISODE_OBSERVATIONS,
  MAX_OBSERVATION_BATCH_READ,
  MAX_OBSERVATION_CONTENT_CHARACTERS,
} from "@corespeed/lore-core/episodes";
import {
  CODE_INDEX_LIMITS,
  MAXIMUM_CODE_DEPENDENCY_RESULTS,
  MAXIMUM_CODE_SEARCH_RESULTS,
} from "@/modules/code/indexing/protocol";
import {
  MAX_WORKSPACE_ARCHIVE_LINKS,
  MAX_WORKSPACE_ARCHIVE_MEMORIES,
} from "@/modules/portability/limits";
import {
  MAXIMUM_MEMORY_PROPOSAL_EVIDENCE,
  MAXIMUM_MEMORY_PROPOSAL_LIST,
  MAXIMUM_PENDING_MEMORY_PROPOSALS,
  MEMORY_PROPOSAL_RETENTION_DAYS,
} from "@/modules/proposals/limits";

/**
 * The limits a deployment publishes in its capabilities, taken from the constants
 * that enforce them. The response and the OpenAPI `const` values both read this.
 */
export const DEPLOYMENT_LIMITS = {
  memoryContentRecommendedCharacters: MEMORY_CONTENT_LIMITS.recommendedCharacters,
  memoryContentMaximumCharacters: MEMORY_CONTENT_LIMITS.maximumCharacters,
  memoryMaximumChunks: MEMORY_CONTENT_LIMITS.maximumChunks,
  workspaceArchiveMemories: MAX_WORKSPACE_ARCHIVE_MEMORIES,
  workspaceArchiveLinks: MAX_WORKSPACE_ARCHIVE_LINKS,
  memoryProposalEvidence: MAXIMUM_MEMORY_PROPOSAL_EVIDENCE,
  memoryProposalList: MAXIMUM_MEMORY_PROPOSAL_LIST,
  memoryProposalPending: MAXIMUM_PENDING_MEMORY_PROPOSALS,
  memoryProposalRetentionSeconds: MEMORY_PROPOSAL_RETENTION_DAYS * 24 * 60 * 60,
  episodeObservations: MAX_EPISODE_OBSERVATIONS,
  episodeContentCharacters: MAX_EPISODE_CONTENT_CHARACTERS,
  episodeMetadataCharacters: MAX_EPISODE_METADATA_CHARACTERS,
  observationContentCharacters: MAX_OBSERVATION_CONTENT_CHARACTERS,
  observationBatchRead: MAX_OBSERVATION_BATCH_READ,
  codeIndexFiles: CODE_INDEX_LIMITS.maximumFiles,
  codeIndexSourceBytes: CODE_INDEX_LIMITS.maximumSourceBytes,
  codeIndexArtifacts: CODE_INDEX_LIMITS.maximumArtifacts,
  codeDependencyResults: MAXIMUM_CODE_DEPENDENCY_RESULTS,
  codeSearchResults: MAXIMUM_CODE_SEARCH_RESULTS,
  memoryLinkMetadataCharacters: MEMORY_LINK_LIMITS.maximumMetadataSerializedLength,
  memoryLinkKindsPerPair: MEMORY_LINK_LIMITS.maximumKindsPerPair,
  memoryLinksPerSource: MEMORY_LINK_LIMITS.maximumLinksPerSource,
  memoryLinksPerTarget: MEMORY_LINK_LIMITS.maximumLinksPerTarget,
  memoryLinksPerOwner: MEMORY_LINK_LIMITS.maximumLinksPerOwner,
  memoryLinkList: MEMORY_LINK_LIMITS.maximumListLimit,
  graphLinks: MEMORY_GRAPH_LIMITS.maximumLinks,
} as const;

export const MEMORY_CHUNKING_CAPABILITY = {
  revision: MEMORY_CHUNKING_REVISION,
  maximumCharacters: MEMORY_CHUNK_MAXIMUM_CHARACTERS,
  overlapCharacters: MEMORY_CHUNK_OVERLAP_CHARACTERS,
} as const;
