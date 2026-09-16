"use client";

import { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";
import { forgetMemory, rememberMemory, updateMemory } from "@/modules/memories/client";
import type { MemoryScope } from "@/modules/memories/schemas";
import { createWorkspace } from "@/modules/workspaces/client";
import { loreKeys } from "@/shared/browser/cache-keys";

interface SaveMemoryInput {
  id?: string;
  content: string;
  scope: MemoryScope;
  version?: number;
}

export function useLoreMutations(workspaceId: string) {
  const { mutate: mutateCache } = useSWRConfig();
  const createWorkspaceMutation = useSWRMutation(
    loreKeys.createWorkspace,
    (_key, { arg }: { arg: string }) => createWorkspace(arg),
  );
  const saveMemoryMutation = useSWRMutation(
    workspaceId ? loreKeys.saveMemory(workspaceId) : null,
    (_key, { arg }: { arg: SaveMemoryInput }) =>
      arg.id
        ? updateMemory(
            workspaceId,
            arg.id,
            { content: arg.content, scope: arg.scope },
            arg.version ?? 1,
          )
        : rememberMemory(workspaceId, { content: arg.content, scope: arg.scope }),
  );
  const forgetMemoryMutation = useSWRMutation(
    workspaceId ? loreKeys.forgetMemory(workspaceId) : null,
    (_key, { arg }: { arg: { id: string; version: number } }) =>
      forgetMemory(workspaceId, arg.id, arg.version),
  );

  return {
    mutateCache,
    createWorkspace: createWorkspaceMutation,
    saveMemory: saveMemoryMutation,
    forgetMemory: forgetMemoryMutation,
    isMutating:
      createWorkspaceMutation.isMutating ||
      saveMemoryMutation.isMutating ||
      forgetMemoryMutation.isMutating,
  };
}
