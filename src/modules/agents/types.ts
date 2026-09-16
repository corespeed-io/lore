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
