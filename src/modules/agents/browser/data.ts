"use client";

import type {
  AgentCredential,
  AgentGrantPermission,
  AgentWorkspaceGrant,
  IssuedAgentCredential,
  WorkspaceAgent,
} from "@corespeed/lore-sdk";
import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";
import { loreKeys } from "@/shared/browser/cache-keys";
import { getBrowserClient } from "@/shared/browser/sdk";

export function listAgents(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<readonly WorkspaceAgent[]> {
  return getBrowserClient().workspace(workspaceId).listAgents(signal);
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

export function listAgentCredentials(
  workspaceId: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<readonly AgentCredential[]> {
  return getBrowserClient().workspace(workspaceId).listAgentCredentials(agentId, signal);
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

export function useLoreAgents(workspaceId: string) {
  return useSWR(workspaceId ? loreKeys.agents(workspaceId) : null, ([, , scopedWorkspaceId]) =>
    listAgents(scopedWorkspaceId),
  );
}

export function useLoreAgentCredentials(workspaceId: string, agentId: string, enabled = true) {
  return useSWR(
    workspaceId && agentId && enabled ? loreKeys.agentCredentials(workspaceId, agentId) : null,
    ([, , scopedWorkspaceId, scopedAgentId]) =>
      listAgentCredentials(scopedWorkspaceId, scopedAgentId),
  );
}

export function useLoreAgentMutations(workspaceId: string) {
  const { mutate: mutateCache } = useSWRConfig();
  const mutationKey = workspaceId ? loreKeys.manageAgents(workspaceId) : null;
  const createAgentMutation = useSWRMutation(
    mutationKey,
    (_key, { arg }: { arg: { name: string; permission: AgentGrantPermission } }) =>
      createAgent(workspaceId, arg),
  );
  const issueCredentialMutation = useSWRMutation(
    mutationKey,
    (_key, { arg }: { arg: { agentId: string } }) => issueAgentCredential(workspaceId, arg.agentId),
  );
  const updateAgentMutation = useSWRMutation(
    mutationKey,
    (
      _key,
      {
        arg,
      }: {
        arg: { agentId: string; name?: string; status?: WorkspaceAgent["status"] };
      },
    ) =>
      updateAgent(workspaceId, arg.agentId, { name: arg.name, status: arg.status }).then(
        async (updated) => {
          await mutateCache(
            isLoreAgentsCacheKey,
            (current: readonly WorkspaceAgent[] | undefined) =>
              current?.map((candidate) =>
                candidate.id === updated.id
                  ? {
                      ...candidate,
                      name: updated.name,
                      status: updated.status,
                      updatedAt: updated.updatedAt,
                    }
                  : candidate,
              ),
            { revalidate: false },
          );
          return updated;
        },
      ),
  );
  const deleteAgentMutation = useSWRMutation(
    mutationKey,
    async (_key, { arg }: { arg: { agentId: string } }) => {
      await deleteAgent(workspaceId, arg.agentId);
      await Promise.all([
        mutateCache(
          isLoreAgentsCacheKey,
          (current: readonly WorkspaceAgent[] | undefined) =>
            current?.filter((candidate) => candidate.id !== arg.agentId),
          { revalidate: false },
        ),
        mutateCache((key) => isLoreAgentCredentialsCacheKey(key, arg.agentId), undefined, {
          revalidate: false,
        }),
      ]);
    },
  );
  const setGrantMutation = useSWRMutation(
    mutationKey,
    (_key, { arg }: { arg: { agentId: string; permission: AgentGrantPermission } }) =>
      setAgentGrant(workspaceId, arg.agentId, arg.permission),
  );
  const revokeGrantMutation = useSWRMutation(
    mutationKey,
    (_key, { arg }: { arg: { agentId: string } }) => revokeAgentGrant(workspaceId, arg.agentId),
  );
  const revokeCredentialMutation = useSWRMutation(
    mutationKey,
    (_key, { arg }: { arg: { credentialId: string } }) =>
      revokeAgentCredential(workspaceId, arg.credentialId),
  );

  return {
    createAgent: createAgentMutation,
    updateAgent: updateAgentMutation,
    deleteAgent: deleteAgentMutation,
    issueCredential: issueCredentialMutation,
    setGrant: setGrantMutation,
    revokeGrant: revokeGrantMutation,
    revokeCredential: revokeCredentialMutation,
    isMutating:
      createAgentMutation.isMutating ||
      updateAgentMutation.isMutating ||
      deleteAgentMutation.isMutating ||
      issueCredentialMutation.isMutating ||
      setGrantMutation.isMutating ||
      revokeGrantMutation.isMutating ||
      revokeCredentialMutation.isMutating,
  };
}

export function isLoreAgentsCacheKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === "lore" && key[1] === "agents";
}

export function isLoreAgentCredentialsCacheKey(key: unknown, agentId: string): boolean {
  return (
    Array.isArray(key) && key[0] === "lore" && key[1] === "agent-credentials" && key[3] === agentId
  );
}
