"use client";

import { useEffect, useMemo } from "react";
import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import useSWRMutation from "swr/mutation";
import {
  createWorkspace,
  forgetMemory,
  getMemory,
  listMemories,
  listWorkspaces,
  readGraph,
  rememberMemory,
  searchMemories,
  updateMemory,
} from "./lore-api";
import type { Memory, MemoryScope } from "./types";

export const MEMORY_PAGE_SIZE = 100;

export const loreKeys = {
  workspaces: ["lore", "workspaces"] as const,
  memories: (workspaceId: string, pageIndex: number) =>
    ["lore", "memories", workspaceId, pageIndex] as const,
  memory: (workspaceId: string, memoryId: string) =>
    ["lore", "memory", workspaceId, memoryId] as const,
  search: (workspaceId: string, query: string, limit: number) =>
    ["lore", "search", workspaceId, query, limit] as const,
  graph: (workspaceId: string) => ["lore", "graph", workspaceId] as const,
  createWorkspace: ["lore", "mutation", "create-workspace"] as const,
  saveMemory: (workspaceId: string) => ["lore", "mutation", "save-memory", workspaceId] as const,
  forgetMemory: (workspaceId: string) =>
    ["lore", "mutation", "forget-memory", workspaceId] as const,
};

export function upsertMemoryPages(
  pages: Memory[][] | undefined,
  saved: Memory,
): Memory[][] | undefined {
  if (!pages?.length) return pages;
  const memories = [saved, ...pages.flat().filter((memory) => memory.id !== saved.id)];
  return pages.map((_, pageIndex) =>
    memories.slice(pageIndex * MEMORY_PAGE_SIZE, (pageIndex + 1) * MEMORY_PAGE_SIZE),
  );
}

export function removeMemoryFromPages(
  pages: Memory[][] | undefined,
  memoryId: string,
): Memory[][] | undefined {
  if (!pages?.length) return pages;
  const memories = pages.flat().filter((memory) => memory.id !== memoryId);
  return pages.map((_, pageIndex) =>
    memories.slice(pageIndex * MEMORY_PAGE_SIZE, (pageIndex + 1) * MEMORY_PAGE_SIZE),
  );
}

export function useLoreWorkspaces() {
  return useSWR(loreKeys.workspaces, () => listWorkspaces());
}

export function useLoreMemories(workspaceId: string) {
  const swr = useSWRInfinite(
    (pageIndex, previousPage: Memory[] | null) => {
      if (!workspaceId || (previousPage && previousPage.length < MEMORY_PAGE_SIZE)) return null;
      return loreKeys.memories(workspaceId, pageIndex);
    },
    ([, , scopedWorkspaceId, pageIndex]) =>
      listMemories(scopedWorkspaceId, {
        limit: MEMORY_PAGE_SIZE,
        offset: pageIndex * MEMORY_PAGE_SIZE,
      }),
    { revalidateFirstPage: false },
  );

  const pageCount = swr.data?.length ?? 0;
  const lastPageLength = swr.data?.at(-1)?.length ?? 0;

  // Keep fetching API-sized pages until the Workspace is exhausted. The cache
  // remains page-addressable, so one component does not need a bespoke 20k cap.
  useEffect(() => {
    if (
      !workspaceId ||
      !swr.data ||
      swr.isValidating ||
      swr.size !== pageCount ||
      lastPageLength < MEMORY_PAGE_SIZE
    ) {
      return;
    }
    void swr.setSize(pageCount + 1);
  }, [lastPageLength, pageCount, swr.data, swr.isValidating, swr.setSize, swr.size, workspaceId]);

  const memories = useMemo(() => {
    const seen = new Set<string>();
    return (swr.data ?? []).flat().filter((memory) => {
      if (seen.has(memory.id)) return false;
      seen.add(memory.id);
      return true;
    });
  }, [swr.data]);

  return {
    ...swr,
    memories,
    isLoading: Boolean(workspaceId) && !swr.data && !swr.error,
    isLoadingMore:
      Boolean(workspaceId) &&
      Boolean(swr.data) &&
      (swr.isValidating || lastPageLength === MEMORY_PAGE_SIZE),
  };
}

export function useLoreMemory(workspaceId: string, memoryId: string | null) {
  return useSWR(
    workspaceId && memoryId ? loreKeys.memory(workspaceId, memoryId) : null,
    ([, , scopedWorkspaceId, scopedMemoryId]) => getMemory(scopedWorkspaceId, scopedMemoryId),
  );
}

export function useLoreSearch(workspaceId: string, query: string, limit = 25) {
  const normalizedQuery = query.trim();
  return useSWR(
    workspaceId && normalizedQuery ? loreKeys.search(workspaceId, normalizedQuery, limit) : null,
    ([, , scopedWorkspaceId, scopedQuery, scopedLimit]) =>
      searchMemories(scopedWorkspaceId, scopedQuery, scopedLimit),
    { keepPreviousData: false },
  );
}

export function useLoreGraph(workspaceId: string) {
  return useSWR(workspaceId ? loreKeys.graph(workspaceId) : null, ([, , scopedWorkspaceId]) =>
    readGraph(scopedWorkspaceId),
  );
}

interface SaveMemoryInput {
  id?: string;
  content: string;
  scope: MemoryScope;
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
        ? updateMemory(workspaceId, arg.id, { content: arg.content, scope: arg.scope })
        : rememberMemory(workspaceId, { content: arg.content, scope: arg.scope }),
  );
  const forgetMemoryMutation = useSWRMutation(
    workspaceId ? loreKeys.forgetMemory(workspaceId) : null,
    (_key, { arg }: { arg: string }) => forgetMemory(workspaceId, arg),
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
