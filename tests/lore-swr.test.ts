import { expect, test } from "vitest";
import {
  loreKeys,
  MAX_MEMORY_PAGES,
  MEMORY_PAGE_SIZE,
  removeMemoryFromPages,
  shouldLoadNextMemoryPage,
  upsertMemoryPages,
} from "@/lib/lore-swr";
import type { Memory } from "@/lib/types";

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
    workspaceId,
    hasData: true,
    hasError: false,
    isValidating: false,
    requestedSize: 2,
    pageCount: 2,
    lastPageLength: MEMORY_PAGE_SIZE,
  };

  expect(shouldLoadNextMemoryPage(ready)).toBe(true);
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
