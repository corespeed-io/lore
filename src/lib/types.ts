export type MemoryScope = "shared" | "private";

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  createdAt: string;
  updatedAt: string;
}

export interface HumanActorSummary {
  kind: "human";
  userId: string;
}

export type AgentGrantPermission = "read" | "write";

export interface WorkspaceAgent {
  id: string;
  ownerUserId: string;
  name: string;
  status: "active" | "disabled";
  permission: AgentGrantPermission;
  grantStatus: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}

export interface AgentWorkspaceGrant {
  workspaceId: string;
  agentId: string;
  permission: AgentGrantPermission;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}

export interface AgentCredential {
  id: string;
  agentId: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface IssuedAgentCredential {
  id: string;
  prefix: string;
  token: string;
}

export interface Memory {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  createdByAgentId: string | null;
  scope: MemoryScope;
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult {
  memory: Memory;
  score: number;
  rerankScore?: number;
  evidence: string;
}

export type EpisodeKind = "conversation" | "workflow" | "document" | "event";

export type ObservationKind =
  | "message"
  | "tool_call"
  | "tool_result"
  | "document_fragment"
  | "event";

export interface Observation {
  id: string;
  workspaceId: string;
  episodeId: string;
  ordinal: number;
  kind: ObservationKind;
  observedAt: string;
  payloadSha256: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EpisodeSummary {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  recordedByActorKind: "human" | "agent";
  recordedByAgentId: string | null;
  kind: EpisodeKind;
  scope: MemoryScope;
  startedAt: string;
  endedAt: string;
  observationCount: number;
  createdAt: string;
}

export interface Episode extends EpisodeSummary {
  observations: Observation[];
}

export type MemoryProposalStatus = "pending" | "accepted" | "rejected";

export interface MemoryProposalCodeEvidence {
  ordinal: number;
  repositoryId: string;
  citedRevisionId: string;
  citedGenerationId: string;
  citedArtifactId: string;
  citedCommitOid: string;
  citedPath: string;
  citedSymbolKey: string | null;
  citedDeclarationKey: string | null;
  citedDeclarationChunkOrdinal: number | null;
  citedDeclarationContextSha256: string | null;
  citedContentSha256: string;
  relationship: "contradicts" | "implements" | "rationale" | "supports";
}

export type CodeEvidenceRelationship = "contradicts" | "implements" | "rationale" | "supports";

export type CodeEvidenceValidationState =
  | "ambiguous"
  | "changed"
  | "current"
  | "deleted"
  | "moved"
  | "unverifiable";

// The browser mirror of the server `MemoryCodeEvidence` contract. Repository
// identity stays a Workspace-scoped UUID plus the cited commit OID; an
// operator-only `repositoryPath` is never part of the public surface.
export interface MemoryCodeEvidence {
  id: string;
  memoryId: string;
  repositoryId: string;
  citedRevisionId: string;
  citedGenerationId: string;
  citedArtifactId: string;
  citedCommitOid: string;
  citedPath: string;
  citedSymbolKey: string | null;
  citedDeclarationKey: string | null;
  citedDeclarationChunkOrdinal: number | null;
  citedDeclarationContextSha256: string | null;
  citedContentSha256: string;
  relationship: CodeEvidenceRelationship;
  validationState: CodeEvidenceValidationState;
  validatedRevisionId: string | null;
  validatedGenerationId: string | null;
  validatedArtifactId: string | null;
  validatedCommitOid: string | null;
  validatedPath: string | null;
  createdByUserId: string;
  createdByAgentId: string | null;
  createdAt: string;
  validatedAt: string;
}

export type CodeIndexJobStatus = "cancelled" | "dead" | "pending" | "processing" | "succeeded";

export interface CodeIndexJob {
  id: string;
  repositoryId: string;
  repositoryKey: string;
  commitOid: string;
  sourceRef: string | null;
  indexerRevision: string;
  status: CodeIndexJobStatus;
  attemptCount: number;
  maximumAttempts: number;
  availableAt: string;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryProposal {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  proposedByActorKind: "human" | "agent";
  proposedByAgentId: string | null;
  kind: "create" | "update";
  targetMemoryId: string | null;
  baseMemoryVersion: number | null;
  proposedContent: string;
  proposedScope: MemoryScope;
  proposedMetadata: Record<string, unknown>;
  evidenceMemoryIds: string[];
  evidenceObservationIds: string[];
  codeEvidence: MemoryProposalCodeEvidence[];
  status: MemoryProposalStatus;
  reviewedByUserId: string | null;
  acceptedMemoryId: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface MemoryProposalReviewResult {
  proposal: MemoryProposal;
  memory: Memory | null;
}

export interface GraphNode {
  id: string;
  reference: string;
  label: string;
  type: string;
  preview: string;
  scope: MemoryScope;
  updatedAt: string;
}

export interface GraphLink {
  source: string;
  target: string;
  kind: string;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface MemorySourceSummary {
  id: string;
  name: string;
  memoryCount: number;
}
