"use client";

import type { Memory } from "@corespeed/lore-sdk";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { loreKeys } from "@/shared/browser/cache-keys";
import { useRevalidateOnResume } from "@/shared/browser/use-revalidate-on-resume";
import { getMemory, listMemories, searchMemories } from "./client";

export const MEMORY_PAGE_SIZE = 100;

export const MAX_MEMORY_PAGES = 50;

export function upsertMemoryPages(
  pages: readonly (readonly Memory[])[] | undefined,
  saved: Memory,
): Memory[][] {
  if (!pages?.length) return [[saved]];
  const memories = [saved, ...pages.flat().filter((memory) => memory.id !== saved.id)];
  return pages.map((_, pageIndex) =>
    memories.slice(pageIndex * MEMORY_PAGE_SIZE, (pageIndex + 1) * MEMORY_PAGE_SIZE),
  );
}

interface MemoryPageAdvanceState {
  enabled: boolean;
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
    state.enabled &&
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
  pages: (readonly Memory[])[] | undefined,
  memoryId: string,
): (readonly Memory[])[] | undefined {
  if (!pages?.length) return pages;
  const memories = pages.flat().filter((memory) => memory.id !== memoryId);
  return pages.map((_, pageIndex) =>
    memories.slice(pageIndex * MEMORY_PAGE_SIZE, (pageIndex + 1) * MEMORY_PAGE_SIZE),
  );
}

class MemoryBrowseCancelled extends Error {
  override name = "AbortError";
}

export function useLoreMemories(workspaceId: string, enabled = true) {
  const demand = useRef({ workspaceId, enabled });
  useLayoutEffect(() => {
    demand.current = { workspaceId, enabled };
    return () => {
      demand.current = { workspaceId, enabled: false };
    };
  }, [enabled, workspaceId]);

  const swr = useSWRInfinite(
    (pageIndex, previousPage: readonly Memory[] | null) => {
      if (
        !workspaceId ||
        pageIndex >= MAX_MEMORY_PAGES ||
        (previousPage && previousPage.length < MEMORY_PAGE_SIZE)
      ) {
        return null;
      }
      return loreKeys.memories(workspaceId, pageIndex);
    },
    ([, , scopedWorkspaceId, pageIndex]) => {
      // An in-flight SWR Infinite refresh can continue across route changes.
      // Let its current request finish, but stop before issuing another page.
      if (!demand.current.enabled || demand.current.workspaceId !== scopedWorkspaceId) {
        throw new MemoryBrowseCancelled("Memory browse is no longer active");
      }
      return listMemories(scopedWorkspaceId, {
        limit: MEMORY_PAGE_SIZE,
        offset: pageIndex * MEMORY_PAGE_SIZE,
      });
    },
    {
      revalidateFirstPage: false,
      isPaused: () => !enabled,
      shouldRetryOnError: (error) => !(error instanceof MemoryBrowseCancelled),
    },
  );
  const resuming = useRevalidateOnResume(workspaceId, enabled, swr.isValidating, swr.mutate);
  const mutate = useCallback<typeof swr.mutate>(
    (...args) => {
      if (demand.current.enabled) return swr.mutate(...args);
      // Paused revalidation would discard SWR's in-flight request without
      // replacing it. Cache patches are still safe with revalidation disabled.
      if (!args.length) return Promise.resolve(swr.data);
      const [data, options] = args;
      return swr.mutate(data, {
        ...(typeof options === "object" ? options : {}),
        revalidate: false,
      });
    },
    [swr.data, swr.mutate],
  );

  const error = enabled && !(swr.error instanceof MemoryBrowseCancelled) ? swr.error : undefined;

  const pageCount = swr.data?.length ?? 0;
  const lastPageLength = swr.data?.at(-1)?.length ?? 0;

  // Fill the existing 5k browse window only while a view needs it. Cached pages
  // remain available while paused; ranked search has its own request and budget.
  useEffect(() => {
    if (resuming) return;
    if (
      !shouldLoadNextMemoryPage({
        enabled,
        workspaceId,
        hasData: Boolean(swr.data),
        hasError: Boolean(error),
        isValidating: swr.isValidating,
        requestedSize: swr.size,
        pageCount,
        lastPageLength,
      })
    )
      return;
    void swr.setSize(pageCount + 1);
  }, [
    enabled,
    error,
    lastPageLength,
    pageCount,
    resuming,
    swr.data,
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
    mutate,
    error,
    memories,
    isLoading: enabled && Boolean(workspaceId) && !swr.data && !error,
    isValidating: enabled && swr.isValidating,
    isLoadingMore:
      enabled &&
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
