import { expect, test } from "vitest";
import {
  isLoreAgentCredentialsCacheKey,
  isLoreAgentsCacheKey,
} from "@/modules/agents/browser/data";
import {
  MAX_MEMORY_PAGES,
  MEMORY_PAGE_SIZE,
  MEMORY_RESUME_FULL_REFRESH_MS,
  memoryPageIndex,
  removeMemoryFromPages,
  sameMemoryPage,
  sameMemoryPageMembership,
  shouldFullyRevalidateOnResume,
  shouldLoadNextMemoryPage,
  shouldRevalidateMemoryPageOnResume,
  upsertMemoryPages,
} from "@/modules/memories/browser/data";
import type { Memory } from "@/modules/memories/schemas";
import { loreKeys } from "@/shared/browser/cache-keys";

const workspaceId = "10000000-0000-4000-8000-000000000001";

function memory(index: number): Memory {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    workspaceId,
    ownerUserId: "20000000-0000-4000-8000-000000000001",
    createdByAgentId: null,
    scope: "shared",
    content: `Memory ${index}`,
    metadata: {},
    version: 1,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
}

test("Lore cache keys isolate Workspace, query, and result shape", () => {
  expect(loreKeys.memories(workspaceId, 2)).toEqual(["lore", "memories", workspaceId, 2]);
  expect(loreKeys.search(workspaceId, "graph", 12)).not.toEqual(
    loreKeys.search(workspaceId, "graph", 25),
  );
  expect(loreKeys.graph(workspaceId)).not.toEqual(
    loreKeys.graph("10000000-0000-4000-8000-000000000002"),
  );
  expect(loreKeys.agents(workspaceId)).not.toEqual(
    loreKeys.agents("10000000-0000-4000-8000-000000000002"),
  );
  expect(loreKeys.memoryProposals(workspaceId, "pending")).not.toEqual(
    loreKeys.memoryProposals(workspaceId, "accepted"),
  );
  expect(loreKeys.observations(workspaceId, ["observation-a"])).not.toEqual(
    loreKeys.observations(workspaceId, ["observation-b"]),
  );
  expect(loreKeys.observations(workspaceId, ["observation-a"])).not.toEqual(
    loreKeys.observations("10000000-0000-4000-8000-000000000002", ["observation-a"]),
  );
  expect(loreKeys.memoryProposals(workspaceId, "pending")).not.toEqual(
    loreKeys.memoryProposals("10000000-0000-4000-8000-000000000002", "pending"),
  );
  expect(loreKeys.agentCredentials(workspaceId, "agent-a")).not.toEqual(
    loreKeys.agentCredentials(workspaceId, "agent-b"),
  );
  expect(loreKeys.capabilities(workspaceId)).not.toEqual(
    loreKeys.capabilities("10000000-0000-4000-8000-000000000002"),
  );
  expect(loreKeys.currentActor(workspaceId)).not.toEqual(
    loreKeys.currentActor("10000000-0000-4000-8000-000000000002"),
  );
  expect(loreKeys.validateWorkspaceImport(workspaceId)).not.toEqual(
    loreKeys.importWorkspace(workspaceId),
  );
});

test("Agent cache predicates reconcile global identity without crossing credential owners", () => {
  const otherWorkspaceId = "10000000-0000-4000-8000-000000000002";
  const agentId = "30000000-0000-4000-8000-000000000001";
  const otherAgentId = "30000000-0000-4000-8000-000000000002";

  expect(isLoreAgentsCacheKey(loreKeys.agents(workspaceId))).toBe(true);
  expect(isLoreAgentsCacheKey(loreKeys.agents(otherWorkspaceId))).toBe(true);
  expect(isLoreAgentsCacheKey(loreKeys.agentCredentials(workspaceId, agentId))).toBe(false);

  expect(
    isLoreAgentCredentialsCacheKey(loreKeys.agentCredentials(workspaceId, agentId), agentId),
  ).toBe(true);
  expect(
    isLoreAgentCredentialsCacheKey(loreKeys.agentCredentials(otherWorkspaceId, agentId), agentId),
  ).toBe(true);
  expect(
    isLoreAgentCredentialsCacheKey(loreKeys.agentCredentials(workspaceId, otherAgentId), agentId),
  ).toBe(false);
  expect(isLoreAgentCredentialsCacheKey(loreKeys.agents(workspaceId), agentId)).toBe(false);
});

test("upserting a Memory preserves page boundaries without duplicates", () => {
  const pages = [
    Array.from({ length: MEMORY_PAGE_SIZE }, (_, index) => memory(index)),
    [memory(MEMORY_PAGE_SIZE)],
  ];
  const saved = { ...memory(MEMORY_PAGE_SIZE), content: "Updated", version: 2 };

  const updated = upsertMemoryPages(pages, saved);

  expect(updated?.[0]?.[0]).toEqual(saved);
  expect(updated?.[0]).toHaveLength(MEMORY_PAGE_SIZE);
  expect(updated?.flat().filter((item) => item.id === saved.id)).toHaveLength(1);
});

test("upserting before the first page arrives seeds the cache", () => {
  expect(upsertMemoryPages(undefined, memory(0))).toEqual([[memory(0)]]);
});

test("removing a Memory compacts cached pages", () => {
  const pages = [
    Array.from({ length: MEMORY_PAGE_SIZE }, (_, index) => memory(index)),
    [memory(MEMORY_PAGE_SIZE)],
  ];

  const updated = removeMemoryFromPages(pages, memory(0).id);

  expect(updated?.[0]).toHaveLength(MEMORY_PAGE_SIZE);
  expect(updated?.[0]?.at(-1)?.id).toBe(memory(MEMORY_PAGE_SIZE).id);
  expect(updated?.[1]).toEqual([]);
});

test("Memory pagination advances only from a settled full page inside the browse budget", () => {
  const ready = {
    enabled: true,
    workspaceId,
    hasData: true,
    hasError: false,
    isValidating: false,
    requestedSize: 2,
    pageCount: 2,
    lastPageLength: MEMORY_PAGE_SIZE,
  };

  expect(shouldLoadNextMemoryPage(ready)).toBe(true);
  expect(shouldLoadNextMemoryPage({ ...ready, enabled: false })).toBe(false);
  expect(shouldLoadNextMemoryPage({ ...ready, hasError: true })).toBe(false);
  expect(shouldLoadNextMemoryPage({ ...ready, requestedSize: 3 })).toBe(false);
  expect(shouldLoadNextMemoryPage({ ...ready, lastPageLength: 99 })).toBe(false);
  expect(
    shouldLoadNextMemoryPage({
      ...ready,
      requestedSize: MAX_MEMORY_PAGES,
      pageCount: MAX_MEMORY_PAGES,
    }),
  ).toBe(false);
});

function fullPage(first: number): Memory[] {
  return Array.from({ length: MEMORY_PAGE_SIZE }, (_, index) => memory(first + index));
}

test("resuming browse re-reads page 0 and leaves unchanged later pages cached", () => {
  const firstPage = fullPage(0);
  const secondPage = fullPage(MEMORY_PAGE_SIZE);
  const resume = {
    pageIndex: 1,
    cachedPage: secondPage,
    listedPage: [...secondPage],
    firstPageBefore: firstPage,
    firstPageAfter: [...firstPage].reverse(),
  };

  expect(memoryPageIndex(loreKeys.memories(workspaceId, 7))).toBe(7);
  expect(memoryPageIndex(loreKeys.graph(workspaceId))).toBeNull();

  // Page 0 is always re-read, before any later page is considered.
  expect(
    shouldRevalidateMemoryPageOnResume({ ...resume, pageIndex: 0, firstPageAfter: undefined }),
  ).toBe(true);
  // An unchanged (or merely reordered) newest page keeps every boundary behind it.
  expect(shouldRevalidateMemoryPageOnResume(resume)).toBe(false);
  expect(shouldRevalidateMemoryPageOnResume({ ...resume, pageIndex: MAX_MEMORY_PAGES - 1 })).toBe(
    false,
  );
  // A missing page cache, or an unrecognised key, is always fetched.
  expect(shouldRevalidateMemoryPageOnResume({ ...resume, cachedPage: undefined })).toBe(true);
  expect(shouldRevalidateMemoryPageOnResume({ ...resume, pageIndex: null })).toBe(true);
});

test("resuming browse re-reads a page whose list copy diverged from its page cache", () => {
  const secondPage = fullPage(MEMORY_PAGE_SIZE);
  // A local forget compacted the list, but the refresh that would have synced
  // the page cache never finished: skipping it would resurrect the Memory.
  const compacted = [...secondPage.slice(1), memory(2 * MEMORY_PAGE_SIZE)];
  const edited = secondPage.map((item, index) => (index === 5 ? { ...item, version: 2 } : item));
  const resume = {
    pageIndex: 1,
    cachedPage: secondPage,
    listedPage: secondPage,
    firstPageBefore: fullPage(0),
    firstPageAfter: fullPage(0),
  };

  expect(sameMemoryPage(secondPage, [...secondPage])).toBe(true);
  expect(sameMemoryPage(secondPage, edited)).toBe(false);
  expect(sameMemoryPage(secondPage, [...secondPage].reverse())).toBe(false);
  expect(shouldRevalidateMemoryPageOnResume({ ...resume, listedPage: compacted })).toBe(true);
  expect(shouldRevalidateMemoryPageOnResume({ ...resume, listedPage: edited })).toBe(true);
  expect(shouldRevalidateMemoryPageOnResume({ ...resume, listedPage: undefined })).toBe(true);
});

test("a write elsewhere that shifts page 0 re-reads every later page on resume", () => {
  const firstPage = fullPage(0);
  const created = [memory(10_000), ...firstPage.slice(0, -1)];
  const forgotten = [...firstPage.slice(1), memory(MEMORY_PAGE_SIZE)];

  expect(sameMemoryPageMembership(firstPage, [...firstPage].reverse())).toBe(true);
  expect(sameMemoryPageMembership(firstPage, created)).toBe(false);
  expect(sameMemoryPageMembership(firstPage, forgotten)).toBe(false);
  expect(sameMemoryPageMembership(firstPage, firstPage.slice(0, 40))).toBe(false);
  expect(sameMemoryPageMembership(undefined, firstPage)).toBe(false);

  const secondPage = fullPage(MEMORY_PAGE_SIZE);
  for (const firstPageAfter of [created, forgotten]) {
    expect(
      shouldRevalidateMemoryPageOnResume({
        pageIndex: 1,
        cachedPage: secondPage,
        listedPage: secondPage,
        firstPageBefore: firstPage,
        firstPageAfter,
      }),
    ).toBe(true);
  }
});

test("a resume long after the last full read re-reads every page", () => {
  const lastFullReadAt = 1_000_000;

  expect(shouldFullyRevalidateOnResume({ now: lastFullReadAt + 1_000, lastFullReadAt })).toBe(
    false,
  );
  expect(
    shouldFullyRevalidateOnResume({
      now: lastFullReadAt + MEMORY_RESUME_FULL_REFRESH_MS,
      lastFullReadAt,
    }),
  ).toBe(true);
  // No full read recorded for this Workspace yet.
  expect(shouldFullyRevalidateOnResume({ now: lastFullReadAt, lastFullReadAt: null })).toBe(true);
});

test("code cache keys isolate the Memory, Workspace, and requested job depth", () => {
  const memoryId = "40000000-0000-4000-8000-000000000001";
  const otherWorkspaceId = "10000000-0000-4000-8000-000000000002";

  expect(loreKeys.memoryCodeEvidence(workspaceId, memoryId)).toEqual([
    "lore",
    "memory-code-evidence",
    workspaceId,
    memoryId,
  ]);
  expect(loreKeys.memoryCodeEvidence(workspaceId, memoryId)).not.toEqual(
    loreKeys.memoryCodeEvidence(otherWorkspaceId, memoryId),
  );
  expect(loreKeys.memoryCodeEvidence(workspaceId, memoryId)).not.toEqual(
    loreKeys.memoryCodeEvidence(workspaceId, "40000000-0000-4000-8000-000000000002"),
  );
  expect(loreKeys.codeIndexJobs(workspaceId, 20)).not.toEqual(
    loreKeys.codeIndexJobs(otherWorkspaceId, 20),
  );
  expect(loreKeys.codeIndexJobs(workspaceId, 20)).not.toEqual(
    loreKeys.codeIndexJobs(workspaceId, 50),
  );
  // Code reads must never collide with the Memory caches they sit beside.
  expect(loreKeys.memoryCodeEvidence(workspaceId, memoryId)).not.toEqual(
    loreKeys.memory(workspaceId, memoryId),
  );
});
