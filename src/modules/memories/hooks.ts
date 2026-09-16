"use client";

import { useEffect, useMemo } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { loreKeys } from "@/shared/browser/cache-keys";
import { getMemory, listMemories, searchMemories } from "./client";
import type { Memory } from "./schemas";

export const MEMORY_PAGE_SIZE = 100;

export const MAX_MEMORY_PAGES = 50;

export function upsertMemoryPages(pages: Memory[][] | undefined, saved: Memory): Memory[][] {
  if (!pages?.length) return [[saved]];
  const memories = [saved, ...pages.flat().filter((memory) => memory.id !== saved.id)];
  return pages.map((_, pageIndex) =>
    memories.slice(pageIndex * MEMORY_PAGE_SIZE, (pageIndex + 1) * MEMORY_PAGE_SIZE),
  );
}

interface MemoryPageAdvanceState {
  hasData: boolean;
  hasError: boolean;
  isValidating: boolean;
  lastPageLength: number;
  pageCount: number;
  requestedSize: number;
  workspaceId: string;
}

export function shouldLoadNextMemoryPage(state: MemoryPageAdvanceState): boolean {
  return Boolean(
    state.workspaceId &&
      state.hasData &&
      !state.hasError &&
      !state.isValidating &&
      state.requestedSize === state.pageCount &&
      state.pageCount < MAX_MEMORY_PAGES &&
      state.lastPageLength === MEMORY_PAGE_SIZE,
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

export function useLoreMemories(workspaceId: string) {
  const swr = useSWRInfinite(
    (pageIndex, previousPage: Memory[] | null) => {
      if (
        !workspaceId ||
        pageIndex >= MAX_MEMORY_PAGES ||
        (previousPage && previousPage.length < MEMORY_PAGE_SIZE)
      ) {
        return null;
      }
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
  // remains page-addressable and the 5k client budget matches the Graph read
  // model; ranked search still reaches Memories outside the browse window.
  useEffect(() => {
    if (
      !shouldLoadNextMemoryPage({
        workspaceId,
        hasData: Boolean(swr.data),
        hasError: Boolean(swr.error),
        isValidating: swr.isValidating,
        requestedSize: swr.size,
        pageCount,
        lastPageLength,
      })
    )
      return;
    void swr.setSize(pageCount + 1);
  }, [
    lastPageLength,
    pageCount,
    swr.data,
    swr.error,
    swr.isValidating,
    swr.setSize,
    swr.size,
    workspaceId,
  ]);

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
      pageCount < MAX_MEMORY_PAGES &&
      (swr.isValidating || lastPageLength === MEMORY_PAGE_SIZE),
    isCapped: pageCount === MAX_MEMORY_PAGES && lastPageLength === MEMORY_PAGE_SIZE,
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
