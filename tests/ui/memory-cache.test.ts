import type { Memory } from "@corespeed/lore-sdk";
import type { ScopedMutator } from "swr";
import { expect, test, vi } from "vitest";
import { loreKeys } from "@/shared/browser/cache-keys";
import { applyMemoryChange, type MemoryReadCaches } from "@/shell/memory-cache";

const WORKSPACE = "20000000-0000-4000-8000-000000000001";

function memory(id: string): Memory {
  return {
    id,
    workspaceId: WORKSPACE,
    ownerUserId: "10000000-0000-4000-8000-000000000001",
    createdByAgentId: null,
    scope: "shared",
    content: `Memory ${id}`,
    metadata: {},
    version: 1,
    createdAt: "2026-09-26T00:00:00.000000Z",
    updatedAt: "2026-09-26T00:00:00.000000Z",
  };
}

function caches() {
  const calls: unknown[][] = [];
  const mutate = vi.fn(async (...args: unknown[]) => {
    calls.push(args);
    return undefined;
  }) as unknown as ScopedMutator;
  const pages: Memory[][] = [[memory("a"), memory("b")]];
  let current: readonly (readonly Memory[])[] | undefined = pages;
  const mutateMemories = vi.fn(async (update?: unknown) => {
    if (typeof update === "function") current = update(current);
    return current;
  });
  const mutateGraph = vi.fn(async () => undefined);
  const targets = {
    workspaceId: WORKSPACE,
    mutate,
    mutateMemories: mutateMemories as unknown as MemoryReadCaches["mutateMemories"],
    mutateGraph,
  } satisfies MemoryReadCaches;
  return { targets, calls, mutateMemories, mutateGraph, pages: () => current };
}

function searchFilter(calls: unknown[][]): (key: unknown) => boolean {
  const call = calls.find((args) => typeof args[0] === "function");
  if (!call) throw new Error("Expected a search revalidation");
  return call[0] as (key: unknown) => boolean;
}

test("a saved Memory patches its detail and the browse list, then refreshes derived reads", async () => {
  const cache = caches();
  const saved = { ...memory("c"), content: "Saved" };
  await applyMemoryChange({ kind: "saved", memory: saved }, cache.targets);

  expect(cache.calls[0]).toEqual([loreKeys.memory(WORKSPACE, "c"), saved, { revalidate: false }]);
  expect(
    cache
      .pages()
      ?.flat()
      .map((item) => item.id),
  ).toEqual(["c", "a", "b"]);
  expect(cache.mutateMemories).toHaveBeenCalledWith(expect.any(Function), { revalidate: true });
  expect(cache.mutateGraph).toHaveBeenCalledOnce();
  // Every cached search of this Workspace, whatever its limit, and no other.
  const matches = searchFilter(cache.calls);
  expect(matches(loreKeys.search(WORKSPACE, "launch", 25))).toBe(true);
  expect(matches(loreKeys.search(WORKSPACE, "launch", 12))).toBe(true);
  expect(matches(loreKeys.search("other-workspace", "launch", 25))).toBe(false);
  expect(matches(loreKeys.graph(WORKSPACE))).toBe(false);
});

test("a forgotten Memory leaves its detail and every browse page", async () => {
  const cache = caches();
  await applyMemoryChange({ kind: "forgotten", memoryId: "a" }, cache.targets);
  expect(cache.calls[0]).toEqual([
    loreKeys.memory(WORKSPACE, "a"),
    undefined,
    { revalidate: false },
  ]);
  expect(
    cache
      .pages()
      ?.flat()
      .map((item) => item.id),
  ).toEqual(["b"]);
  expect(cache.mutateGraph).toHaveBeenCalledOnce();
});

test("an unknown outcome re-reads the Memory, the browse list, searches, and the Graph", async () => {
  const cache = caches();
  await applyMemoryChange({ kind: "changed", memoryId: "b" }, cache.targets);
  expect(cache.calls[0]).toEqual([loreKeys.memory(WORKSPACE, "b")]);
  expect(cache.mutateMemories).toHaveBeenCalledWith();
  expect(searchFilter(cache.calls)(loreKeys.search(WORKSPACE, "q", 25))).toBe(true);
  expect(cache.mutateGraph).toHaveBeenCalledOnce();

  const imported = caches();
  await applyMemoryChange({ kind: "changed" }, imported.targets);
  expect(imported.calls.some((args) => Array.isArray(args[0]))).toBe(false);
  expect(imported.mutateMemories).toHaveBeenCalledWith();
});
