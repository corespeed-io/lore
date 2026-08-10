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

export type MemoryProposalStatus = "pending" | "accepted" | "rejected";

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
