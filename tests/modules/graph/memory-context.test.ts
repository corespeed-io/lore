import { expect, test } from "vitest";
import { memoryGraphContext } from "@/modules/graph/browser/memory-context";

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
