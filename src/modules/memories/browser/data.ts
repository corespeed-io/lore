"use client";

import type {
  CreateMemoryInput,
  Memory,
  MemoryScope,
  MemorySearchResult,
  UpdateMemoryInput,
} from "@corespeed/lore-sdk";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { loreKeys } from "@/shared/browser/cache-keys";
import { getBrowserClient } from "@/shared/browser/sdk";
import { useRevalidateOnResume } from "@/shared/browser/use-revalidate-on-resume";

export async function listMemories(
  workspaceId: string,
  input: {
    limit?: number;
    metadataFilter?: Record<string, unknown>;
    offset?: number;
    scope?: MemoryScope;
    updatedAfter?: string;
    updatedBefore?: string;
    signal?: AbortSignal;
  } = {},
): Promise<readonly Memory[]> {
  const { metadataFilter, ...filters } = input;
  const page = await getBrowserClient()
    .workspace(workspaceId)
    .listMemories({
      ...filters,
      limit: input.limit ?? 100,
      offset: input.offset ?? 0,
      metadata: metadataFilter,
    });
  return page.memories;
}

export function searchMemories(
  workspaceId: string,
  query: string,
  limit = 25,
  signal?: AbortSignal,
  filters: {
    metadataFilter?: Record<string, unknown>;
    scope?: MemoryScope;
    updatedAfter?: string;
    updatedBefore?: string;
  } = {},
): Promise<readonly MemorySearchResult[]> {
  const { metadataFilter, ...rest } = filters;
  return getBrowserClient()
    .workspace(workspaceId)
    .searchMemories({
      ...rest,
      query,
      limit,
      signal,
      metadata: metadataFilter,
    });
}

export function getMemory(workspaceId: string, id: string, signal?: AbortSignal): Promise<Memory> {
  return getBrowserClient().workspace(workspaceId).getMemory(id, signal);
}

export function rememberMemory(workspaceId: string, input: CreateMemoryInput): Promise<Memory> {
  return getBrowserClient().workspace(workspaceId).remember(input);
}

export function updateMemory(
  workspaceId: string,
  id: string,
  input: UpdateMemoryInput,
  expectedVersion: number,
): Promise<Memory> {
  return getBrowserClient().workspace(workspaceId).updateMemory(id, input, { expectedVersion });
}

export function forgetMemory(
  workspaceId: string,
  id: string,
  expectedVersion: number,
): Promise<void> {
  return getBrowserClient().workspace(workspaceId).forgetMemory(id, { expectedVersion });
}

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

/** The page index of a paged-browse cache key, or null for any other key. */
export function memoryPageIndex(key: unknown): number | null {
  return Array.isArray(key) &&
    key[0] === "lore" &&
    key[1] === "memories" &&
    typeof key[3] === "number"
    ? key[3]
    : null;
}

/** Whether two pages show the same Memory versions in the same order. */
export function sameMemoryPage(
  left: readonly Memory[] | undefined,
  right: readonly Memory[] | undefined,
): boolean {
  if (!left || !right || left.length !== right.length) return false;
  return left.every(
    (memory, index) => memory.id === right[index]?.id && memory.version === right[index]?.version,
  );
}

/** Whether two pages hold the same Memories, regardless of order. */
export function sameMemoryPageMembership(
  left: readonly Memory[] | undefined,
  right: readonly Memory[] | undefined,
): boolean {
  if (!left || !right || left.length !== right.length) return false;
  const ids = new Set(left.map((memory) => memory.id));
  return right.every((memory) => ids.has(memory.id));
}

interface MemoryPageResumeState {
  pageIndex: number | null;
  /** The page as SWR last cached it under its own key. */
  cachedPage: readonly Memory[] | undefined;
  /** The same page as the browse list showed it when browse resumed. */
  listedPage: readonly Memory[] | undefined;
  /** Page 0 as the browse list showed it when browse resumed. */
  firstPageBefore: readonly Memory[] | undefined;
  /** Page 0 as just re-read by this resume; pages are read in order. */
  firstPageAfter: readonly Memory[] | undefined;
}

/**
 * Returning to browse (for example Back from Memory detail) re-reads only the
 * newest page instead of every loaded page, which is up to 50 sequential
 * full-content requests. A later page is read again only when it is missing,
 * when the list diverged from its page cache (a local write whose refresh never
 * finished), or when page 0 gained or lost a Memory: a write elsewhere shifts
 * every page boundary behind it. Explicit writes and imports still revalidate
 * every page.
 */
export function shouldRevalidateMemoryPageOnResume(state: MemoryPageResumeState): boolean {
  if (state.pageIndex === null || state.pageIndex === 0) return true;
  if (!sameMemoryPage(state.cachedPage, state.listedPage)) return true;
  return !sameMemoryPageMembership(state.firstPageBefore, state.firstPageAfter);
}

/**
 * A page-0 resume cannot see a Memory forgotten, or made private, deep in the
 * list by someone else. Re-reading every page once the last full read is this
 * old bounds that staleness without paying for it on every Back.
 */
export const MEMORY_RESUME_FULL_REFRESH_MS = 5 * 60_000;

export function shouldFullyRevalidateOnResume(input: {
  now: number;
  lastFullReadAt: number | null;
}): boolean {
  return (
    input.lastFullReadAt === null ||
    input.now - input.lastFullReadAt >= MEMORY_RESUME_FULL_REFRESH_MS
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

interface MemoryResumeProbe {
  listedPages: readonly (readonly Memory[])[] | undefined;
  firstPageAfter: readonly Memory[] | undefined;
}

export function useLoreMemories(workspaceId: string, enabled = true) {
  const demand = useRef({ workspaceId, enabled });
  const resumeProbe = useRef<MemoryResumeProbe | null>(null);
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
    async ([, , scopedWorkspaceId, pageIndex]) => {
      // An in-flight SWR Infinite refresh can continue across route changes.
      // Let its current request finish, but stop before issuing another page.
      if (!demand.current.enabled || demand.current.workspaceId !== scopedWorkspaceId) {
        throw new MemoryBrowseCancelled("Memory browse is no longer active");
      }
      const page = await listMemories(scopedWorkspaceId, {
        limit: MEMORY_PAGE_SIZE,
        offset: pageIndex * MEMORY_PAGE_SIZE,
      });
      const probe = resumeProbe.current;
      if (pageIndex === 0 && probe) probe.firstPageAfter = page;
      return page;
    },
    {
      revalidateFirstPage: false,
      isPaused: () => !enabled,
      shouldRetryOnError: (error) => !(error instanceof MemoryBrowseCancelled),
    },
  );
  // When this Workspace's browse list was last read in full: its first load, or
  // the last resume that re-read every page.
  const lastFullRead = useRef<{ workspaceId: string; at: number } | null>(null);
  const hasData = Boolean(swr.data);
  useEffect(() => {
    if (hasData && lastFullRead.current?.workspaceId !== workspaceId) {
      lastFullRead.current = { workspaceId, at: Date.now() };
    }
  }, [hasData, workspaceId]);

  const revalidateOnResume = useCallback(() => {
    const now = Date.now();
    const lastFullReadAt =
      lastFullRead.current?.workspaceId === workspaceId ? lastFullRead.current.at : null;
    if (shouldFullyRevalidateOnResume({ now, lastFullReadAt })) {
      lastFullRead.current = { workspaceId, at: now };
      return swr.mutate();
    }
    const probe: MemoryResumeProbe = { listedPages: swr.data, firstPageAfter: undefined };
    resumeProbe.current = probe;
    // No replacement data, so the cache must not be written: the per-page
    // predicate alone selects what SWR Infinite fetches again.
    return swr.mutate(undefined, {
      populateCache: false,
      revalidate: (page, key) => {
        const pageIndex = memoryPageIndex(key);
        return shouldRevalidateMemoryPageOnResume({
          pageIndex,
          cachedPage: page,
          listedPage: pageIndex === null ? undefined : probe.listedPages?.[pageIndex],
          firstPageBefore: probe.listedPages?.[0],
          firstPageAfter: probe.firstPageAfter,
        });
      },
    });
  }, [swr.data, swr.mutate, workspaceId]);
  const resuming = useRevalidateOnResume(
    workspaceId,
    enabled,
    swr.isValidating,
    revalidateOnResume,
  );
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
    // Every visible Memory is loaded: the last page came back short. Until then a
    // count over `memories` is only a lower bound.
    isComplete: Boolean(swr.data) && lastPageLength < MEMORY_PAGE_SIZE,
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
