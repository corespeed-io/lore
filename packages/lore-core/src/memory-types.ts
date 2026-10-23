import type { EmbeddingProvider, QueryPlanningProvider, RerankingProvider } from "./capabilities";
import type { PreparedMemoryContent } from "./memory-content";

/** Who may read a Memory: every member of its Workspace, or only its owner User. */
export const MEMORY_SCOPES = ["shared", "private"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface Memory {
  id: string;
  partitionId: string;
  ownerId: string;
  sourceId: string | null;
  scope: MemoryScope;
  /** A one-line plain-text name, separate from content, or null for none. */
  title: string | null;
  /** An English rendering of content in another language, or null for none. */
  gloss: string | null;
  /**
   * When the event or statement this Memory records happened, as its writer states
   * it (RFC 3339 UTC), or null for none. Not when Lore recorded it: see createdAt.
   */
  occurredAt: string | null;
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RememberMemory {
  content: string;
  scope?: MemoryScope;
  /** Omitted or null for none. */
  title?: string | null;
  /** Omitted or null for none. */
  gloss?: string | null;
  /** An RFC 3339 date-time with an offset; omitted or null for none. */
  occurredAt?: string | null;
  metadata?: Record<string, unknown>;
}

/** One Memory of a batch insert, whose id the caller chose (for example an import). */
export interface InsertMemoryRecord {
  /**
   * A fresh canonical UUID the host generated. Never reuse an id from outside (an
   * archive's own ids): a primary-key collision with a Memory the caller cannot see
   * would reveal that it exists.
   */
  id: string;
  scope: MemoryScope;
  title?: string | null;
  gloss?: string | null;
  occurredAt?: string | null;
  content: string;
  metadata: Record<string, unknown>;
  /**
   * `prepareMemoryContent(content)`, when the host already validated this content;
   * the insert then reuses its chunks instead of chunking the content again.
   */
  preparedContent?: PreparedMemoryContent;
}

export interface UpdateMemory {
  content?: string;
  scope?: MemoryScope;
  /** A new title, null to remove it, or omitted to keep it. */
  title?: string | null;
  /** A new gloss, null to remove it, or omitted to keep it. */
  gloss?: string | null;
  /** A new time (RFC 3339 with an offset), null to remove it, or omitted to keep it. */
  occurredAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MemoryMutationOptions {
  expectedVersion?: number;
}

export interface SearchMemory {
  query: string;
  /**
   * The same question in other languages. Search runs each beside the query and
   * fuses them into one ranking, so it also matches Memories written in them.
   */
  translations?: readonly string[];
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
  /**
   * Optional bulk form for hosts whose transport batches (a queue's sendBatch), so a
   * bulk write sends a few batches instead of one message per job. Without it the
   * engine calls `notify` for each message.
   */
  notifyMany?(messages: readonly MemoryEmbeddingJobMessage[]): void;
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
  title: string | null;
  gloss: string | null;
  occurred_at: string | null;
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}
