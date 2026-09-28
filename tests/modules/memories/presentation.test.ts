import type { Memory } from "@corespeed/lore-sdk";
import { expect, test, vi } from "vitest";
import {
  browseCounts,
  browseFilterEmptyNote,
  browseTypeChips,
  memoryConfiguredType,
  memoryType,
  shortMemoryDate,
  typeSort,
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

// CI and most dev boxes run in UTC, where a local-time formatter also passes, so the
// module is reloaded under zones on each side of the date line to prove the UTC pin.
test.each(["Pacific/Kiritimati", "Pacific/Pago_Pago"])(
  "row dates are the UTC calendar day for a viewer in %s",
  async (zone) => {
    vi.stubEnv("TZ", zone);
    vi.resetModules();
    try {
      const { shortMemoryDate: formatInZone } = await import(
        "@/modules/memories/browser/presentation"
      );
      const utcDay = (day: number) =>
        new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(Date.UTC(2026, 7, day, 12));
      expect(formatInZone("2026-08-05T23:30:00.000Z")).toBe(utcDay(5));
      expect(formatInZone("2026-08-06T00:30:00.000Z")).toBe(utcDay(6));
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test("an unparseable row date renders nothing", () => {
  expect(shortMemoryDate("not a date")).toBe("");
});

test("browse counts are lower bounds until every browse page is read", () => {
  expect(
    browseCounts({ matching: 1200, total: 1200, filtered: false, complete: true }).heading,
  ).toBe("Showing 1,200 memories");
  const filling = browseCounts({ matching: 40, total: 300, filtered: true, complete: false });
  expect(filling.heading).toBe("Showing 40+ of 300+ memories");
  expect(filling.count(300)).toBe("300+");
  const done = browseCounts({ matching: 40, total: 300, filtered: true, complete: true });
  expect(done.heading).toBe("Showing 40 of 300 memories");
  expect(done.count(0)).toBe("0");
});

test("the browse header's noun agrees with the count beside it", () => {
  expect(browseCounts({ matching: 1, total: 1, filtered: false, complete: true }).heading).toBe(
    "Showing 1 memory",
  );
  expect(browseCounts({ matching: 1, total: 1, filtered: true, complete: true }).heading).toBe(
    "Showing 1 of 1 memory",
  );
  expect(browseCounts({ matching: 0, total: 3, filtered: true, complete: true }).heading).toBe(
    "Showing 0 of 3 memories",
  );
  // "1+" is a lower bound, so it stays plural.
  expect(browseCounts({ matching: 1, total: 1, filtered: false, complete: false }).heading).toBe(
    "Showing 1+ memories",
  );
});

test("an unfiltered browse header is a lower bound while pages load or at the browse cap", () => {
  const capped = browseCounts({ matching: 5000, total: 5000, filtered: false, complete: false });
  expect(capped.heading).toBe("Showing 5,000+ memories");
  expect(capped.count(5000)).toBe("5,000+");
});

test("the active type filter keeps its chip even when no loaded Memory has that type", () => {
  expect(browseTypeChips(["concept", "private", "concept"], "all").map(([key]) => key)).toEqual([
    "all",
    ...["concept", "private"].sort(typeSort),
  ]);
  const chips = browseTypeChips(["concept"], "field_note");
  expect(chips.map(([key]) => key)).toContain("field_note");
  expect(chips.find(([key]) => key === "field_note")?.[1]).toBe("field note");
});

test("a type filter with no loaded match says so, and says 'yet' while pages load", () => {
  expect(browseFilterEmptyNote({ matching: 0, filtered: true, complete: true })).toBe(
    "No Memories of this type.",
  );
  expect(browseFilterEmptyNote({ matching: 0, filtered: true, complete: false })).toBe(
    "No Memories of this type have loaded yet.",
  );
  expect(browseFilterEmptyNote({ matching: 3, filtered: true, complete: true })).toBeNull();
  expect(browseFilterEmptyNote({ matching: 0, filtered: false, complete: true })).toBeNull();
});
