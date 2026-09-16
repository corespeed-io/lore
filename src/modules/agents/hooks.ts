"use client";

import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";
import { loreKeys } from "@/shared/browser/cache-keys";
import {
  createAgent,
  deleteAgent,
  issueAgentCredential,
  listAgentCredentials,
  listAgents,
  revokeAgentCredential,
  revokeAgentGrant,
  setAgentGrant,
  updateAgent,
} from "./client";
import type { AgentGrantPermission, WorkspaceAgent } from "./types";

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
            (current: WorkspaceAgent[] | undefined) =>
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
          (current: WorkspaceAgent[] | undefined) =>
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
