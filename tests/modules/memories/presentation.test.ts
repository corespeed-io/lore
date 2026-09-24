import type { Memory } from "@corespeed/lore-sdk";
import { expect, test } from "vitest";
import {
  memoryConfiguredType,
  memoryGraphContext,
  memoryType,
  shortMemoryDate,
} from "@/modules/memories/browser/presentation";

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000001",
    ownerUserId: "20000000-0000-4000-8000-000000000001",
    createdByAgentId: null,
    scope: "private",
    content: "A durable fact",
    metadata: {},
    version: 1,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

test("a typed Memory keeps its scope separate from its type badge", () => {
  const typed = memory({ metadata: { type: " concept " } });
  expect(memoryConfiguredType(typed)).toBe("concept");
  expect(memoryType(typed)).toBe("concept");
  expect(typed.scope).toBe("private");

  const untyped = memory({ metadata: { type: "  " } });
  expect(memoryConfiguredType(untyped)).toBeNull();
  // Grouping still buckets untyped Memories by scope.
  expect(memoryType(untyped)).toBe("private");
});

test("row dates are the UTC calendar day in every viewer time zone", () => {
  const utcDay = (day: number) =>
    new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(
      Date.UTC(2026, 7, day, 12),
    );
  // Either side of UTC midnight: a local-time formatter gets one of these wrong
  // in every time zone that is not UTC.
  expect(shortMemoryDate("2026-08-05T23:30:00.000Z")).toBe(utcDay(5));
  expect(shortMemoryDate("2026-08-06T00:30:00.000Z")).toBe(utcDay(6));
  expect(shortMemoryDate("not a date")).toBe("");
});

test("Memory detail claims nothing from a Graph that has not loaded", () => {
  const loading = memoryGraphContext({
    state: "loading",
    capped: false,
    inGraph: false,
    relatedCount: 0,
  });
  expect(loading.connections).toBe("—");
  expect(loading.relatedNotice).not.toBeNull();
  expect(loading.unresolvedWikilinkTitle).not.toMatch(/not found/i);

  const failed = memoryGraphContext({
    state: "error",
    capped: false,
    inGraph: false,
    relatedCount: 0,
  });
  expect(failed.connections).toBe("—");
  expect(failed.relatedNotice).toBe("Related Memories are currently unavailable.");
  expect(failed.unresolvedWikilinkTitle).not.toMatch(/not found/i);
});

test("a loaded complete Graph may report counts and unresolved references", () => {
  expect(
    memoryGraphContext({ state: "ready", capped: false, inGraph: true, relatedCount: 3 }),
  ).toEqual({
    connections: "3",
    relatedNotice: null,
    unresolvedWikilinkTitle: "Memory reference not found",
  });
  expect(
    memoryGraphContext({ state: "ready", capped: false, inGraph: true, relatedCount: 0 }),
  ).toMatchObject({ connections: "0", relatedNotice: null });
});

test("a capped Graph never claims a reference or connection is absent", () => {
  const outside = memoryGraphContext({
    state: "ready",
    capped: true,
    inGraph: false,
    relatedCount: 0,
  });
  expect(outside.connections).toBe("—");
  expect(outside.relatedNotice).toContain("5,000-Memory read window");
  expect(outside.unresolvedWikilinkTitle).not.toMatch(/not found/i);

  const inside = memoryGraphContext({
    state: "ready",
    capped: true,
    inGraph: true,
    relatedCount: 2,
  });
  expect(inside.connections).toBe("2+");
  expect(inside.relatedNotice).toBeNull();
  expect(inside.unresolvedWikilinkTitle).toContain("5,000-Memory read window");

  const isolatedInWindow = memoryGraphContext({
    state: "ready",
    capped: true,
    inGraph: true,
    relatedCount: 0,
  });
  expect(isolatedInWindow.relatedNotice).toContain("5,000-Memory read window");
});

test("a Memory missing from an uncapped Graph is stale, not unconnected", () => {
  const stale = memoryGraphContext({
    state: "ready",
    capped: false,
    inGraph: false,
    relatedCount: 0,
  });
  expect(stale.connections).toBe("—");
  expect(stale.relatedNotice).toBe("This Memory is not in the loaded Graph yet.");
});
