import type { EmbeddingProvider, QueryPlanningProvider, RerankingProvider } from "./capabilities";

export type MemoryScope = "shared" | "private";

export interface Memory {
  id: string;
  partitionId: string;
  ownerId: string;
  sourceId: string | null;
  scope: MemoryScope;
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RememberMemory {
  content: string;
  scope?: MemoryScope;
  metadata?: Record<string, unknown>;
}

export interface UpdateMemory {
  content?: string;
  scope?: MemoryScope;
  metadata?: Record<string, unknown>;
}

export interface MemoryMutationOptions {
  expectedVersion?: number;
}

export interface SearchMemory {
  query: string;
  limit?: number;
  metadataFilter?: Record<string, unknown>;
  scope?: MemoryScope;
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface ListMemory {
  cursor?: { id: string; updatedAt: string };
  limit?: number;
  offset?: number;
  metadataFilter?: Record<string, unknown>;
  scope?: MemoryScope;
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface MemorySearchResult {
  memory: Memory;
  score: number;
  rerankScore?: number;
  evidence: string;
}

export interface MemoryModuleOptions {
  contextGroupExpansion?: ContextGroupExpansionOptions;
  /**
   * New Memories default to this scope when the caller does not request one.
   * "shared" is lore's product default; hosts with a fail-closed posture may
   * choose "private".
   */
  defaultMemoryScope?: MemoryScope;
  /**
   * The deployment's embedding-space width. A host-baked schema invariant
   * (vector columns, CHECKs, HNSW indexes), not a runtime knob: it must match
   * the host schema exactly. Defaults to the embedding provider's dimensions,
   * then to lore's 1024.
   */
  embeddingDimensions?: number;
  embeddingProvider?: EmbeddingProvider;
  entityAliasRecall?: boolean;
  evidenceNeighborChunks?: number;
  evidenceTopChunks?: number;
  maintenanceNotifier?: MemoryMaintenanceNotifier;
  queryPlanningProvider?: QueryPlanningProvider;
  queryPlannerMaxQueries?: number;
  retrievalFeedbackQueries?: number;
  retrievalRecencyWeight?: number;
  rerankingProvider?: RerankingProvider;
  rerankCandidateLimit?: number;
  rerankDiversityLambda?: number;
  rerankMinimumScore?: number;
  rerankWeight?: number;
  semanticDistanceThreshold?: number;
}

export interface ContextGroupExpansionOptions {
  /** Metadata scalar that identifies an explicit source session/topic/thread. */
  groupMetadataKey: string;
  /** Optional numeric metadata scalar used to prefer nearby members within a group. */
  ordinalMetadataKey?: string;
  /** Ordinary ranked candidates preserved before structural candidates are appended. */
  baseCandidateLimit?: number;
  /** Maximum distinct groups seeded from the preserved ranked candidates. */
  maximumGroups?: number;
}

export interface MemoryEmbeddingJobMessage {
  jobId: string;
}

export interface MemoryMaintenanceNotifier {
  notify(message: MemoryEmbeddingJobMessage): void;
}

/**
 * Raw `memories` row shape, exported with {@link memoryFromRow} for host
 * extensions (for example lore's Memory Proposals module) that select Memory
 * rows inside their own transactions.
 */
export interface MemoryRow {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  created_by_agent_id: string | null;
  scope: MemoryScope;
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}
