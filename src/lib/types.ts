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
