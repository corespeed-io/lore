import { getBrowserClient } from "@/shared/browser/sdk";
import type {
  AgentCredential,
  AgentGrantPermission,
  AgentWorkspaceGrant,
  IssuedAgentCredential,
  WorkspaceAgent,
} from "./types";

export async function listAgents(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceAgent[]> {
  return [...(await getBrowserClient().workspace(workspaceId).listAgents(signal))];
}

export function createAgent(
  workspaceId: string,
  input: { name: string; permission: AgentGrantPermission },
): Promise<WorkspaceAgent> {
  return getBrowserClient().workspace(workspaceId).createAgent(input);
}

export function updateAgent(
  workspaceId: string,
  agentId: string,
  input: { name?: string; status?: WorkspaceAgent["status"] },
): Promise<WorkspaceAgent> {
  return getBrowserClient().workspace(workspaceId).updateAgent(agentId, input);
}

export function deleteAgent(workspaceId: string, agentId: string): Promise<void> {
  return getBrowserClient().workspace(workspaceId).deleteAgent(agentId);
}

export async function listAgentCredentials(
  workspaceId: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<AgentCredential[]> {
  return [
    ...(await getBrowserClient().workspace(workspaceId).listAgentCredentials(agentId, signal)),
  ];
}

export function issueAgentCredential(
  workspaceId: string,
  agentId: string,
): Promise<IssuedAgentCredential> {
  return getBrowserClient().workspace(workspaceId).issueAgentCredential(agentId);
}

export function setAgentGrant(
  workspaceId: string,
  agentId: string,
  permission: AgentGrantPermission,
): Promise<AgentWorkspaceGrant> {
  return getBrowserClient().workspace(workspaceId).setAgentGrant(agentId, permission);
}

export function revokeAgentGrant(workspaceId: string, agentId: string): Promise<void> {
  return getBrowserClient().workspace(workspaceId).revokeAgentGrant(agentId);
}

export function revokeAgentCredential(workspaceId: string, credentialId: string): Promise<void> {
  return getBrowserClient().workspace(workspaceId).revokeAgentCredential(credentialId);
}
