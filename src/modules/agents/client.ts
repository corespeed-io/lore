import { requestJson } from "@/shared/browser/http";
import type {
  AgentCredential,
  AgentGrantPermission,
  AgentWorkspaceGrant,
  IssuedAgentCredential,
  WorkspaceAgent,
} from "./types";

export function listAgents(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceAgent[]> {
  return requestJson("/api/v1/agents", {
    workspaceId,
    operation: "GET /api/v1/agents",
    signal,
  });
}

export function createAgent(
  workspaceId: string,
  input: { name: string; permission: AgentGrantPermission },
): Promise<WorkspaceAgent> {
  return requestJson("/api/v1/agents", {
    method: "POST",
    body: JSON.stringify(input),
    workspaceId,
    operation: "POST /api/v1/agents",
  });
}

export function updateAgent(
  workspaceId: string,
  agentId: string,
  input: { name?: string; status?: WorkspaceAgent["status"] },
): Promise<WorkspaceAgent> {
  return requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    workspaceId,
    operation: "PATCH /api/v1/agents/:id",
  });
}

export function deleteAgent(workspaceId: string, agentId: string): Promise<void> {
  return requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    workspaceId,
    operation: "DELETE /api/v1/agents/:id",
  });
}

export function listAgentCredentials(
  workspaceId: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<AgentCredential[]> {
  return requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}/credentials`, {
    workspaceId,
    operation: "GET /api/v1/agents/:id/credentials",
    signal,
  });
}

export function issueAgentCredential(
  workspaceId: string,
  agentId: string,
): Promise<IssuedAgentCredential> {
  return requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}/credentials`, {
    method: "POST",
    workspaceId,
    operation: "POST /api/v1/agents/:id/credentials",
  });
}

export function setAgentGrant(
  workspaceId: string,
  agentId: string,
  permission: AgentGrantPermission,
): Promise<AgentWorkspaceGrant> {
  return requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}/grant`, {
    method: "PUT",
    body: JSON.stringify({ permission }),
    workspaceId,
    operation: "PUT /api/v1/agents/:id/grant",
  });
}

export function revokeAgentGrant(workspaceId: string, agentId: string): Promise<void> {
  return requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}/grant`, {
    method: "DELETE",
    workspaceId,
    operation: "DELETE /api/v1/agents/:id/grant",
  });
}

export function revokeAgentCredential(workspaceId: string, credentialId: string): Promise<void> {
  return requestJson(`/api/v1/agent-credentials/${encodeURIComponent(credentialId)}`, {
    method: "DELETE",
    workspaceId,
    operation: "DELETE /api/v1/agent-credentials/:id",
  });
}
