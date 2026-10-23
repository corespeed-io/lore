"use client";

import type { MemoryScope } from "@corespeed/lore-sdk";
import { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";
import { forgetMemory, rememberMemory, updateMemory } from "@/modules/memories/browser/data";
import { createWorkspace } from "@/modules/workspaces/browser/data";
import { loreKeys } from "@/shared/browser/cache-keys";

interface SaveMemoryInput {
  id?: string;
  content: string;
  scope: MemoryScope;
  /** Null for none; on an edit, null removes the title. */
  title: string | null;
  /** An English gloss, null for none; on an edit, null removes it. */
  gloss: string | null;
  /** When the event happened (RFC 3339); null removes it, undefined keeps it. */
  occurredAt?: string | null;
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
            {
              content: arg.content,
              scope: arg.scope,
              title: arg.title,
              gloss: arg.gloss,
              ...(arg.occurredAt === undefined ? {} : { occurredAt: arg.occurredAt }),
            },
            arg.version ?? 1,
          )
        : rememberMemory(workspaceId, {
            content: arg.content,
            scope: arg.scope,
            ...(arg.title === null ? {} : { title: arg.title }),
            ...(arg.gloss === null ? {} : { gloss: arg.gloss }),
            ...(arg.occurredAt == null ? {} : { occurredAt: arg.occurredAt }),
          }),
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
