import type { Memory } from "@corespeed/lore-sdk";
import { expect, test, vi } from "vitest";
import {
  memoryBody,
  memoryConfiguredType,
  memoryTitle,
  memoryType,
  plainInline,
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

test("a title taken from the first line shows its text, not its Markdown", () => {
  const titleOf = (content: string) => memoryTitle(memory({ content }));

  expect(titleOf("**corespeed-haas ClickHouse 托管与运维参考**\n\n现状")).toBe(
    "corespeed-haas ClickHouse 托管与运维参考",
  );
  expect(titleOf("## Use `bun run ch:migrate` for [[ops/clickhouse|ClickHouse]]")).toBe(
    "Use bun run ch:migrate for ClickHouse",
  );
  expect(titleOf("See [the runbook](https://example.test/runbook) first")).toBe(
    "See the runbook first",
  );
  // Markup the renderer does not treat as emphasis is text, and stays.
  expect(titleOf("__init__.py loads a * b")).toBe("__init__.py loads a * b");
  // A configured title is shown exactly as set.
  expect(memoryTitle(memory({ content: "**x**", metadata: { title: "**Kept**" } }))).toBe(
    "**Kept**",
  );
});

test("a label cut short loses its unpaired bold marker too", () => {
  expect(plainInline("**ci-runner controller service-account key: org-policy exception…")).toBe(
    "ci-runner controller service-account key: org-policy exception…",
  );
});

test("Memory detail does not repeat a first line written as its title", () => {
  const bodyOf = (content: string, metadata: Memory["metadata"] = {}) =>
    memoryBody(memory({ content, metadata }));

  expect(bodyOf("**Title**\n\nFirst paragraph.")).toBe("First paragraph.");
  expect(bodyOf("### Title\r\n\r\nBody")).toBe("Body");
  expect(bodyOf("【memory 统一用 Lore】\n- one")).toBe("- one");
  expect(bodyOf("**Title**")).toBe("");
  // A title with a trailing note is still shown whole by the title.
  expect(bodyOf("**Spencer wants code** (2026-09-18, Fixo)\nBody")).toBe("Body");
  expect(bodyOf("【规范】（适用范围）\n正文")).toBe("正文");
  // A plain first line may open a paragraph, so it stays.
  expect(bodyOf("A durable fact.\nMore.")).toBe("A durable fact.\nMore.");
  expect(bodyOf("Use **bold** later\nMore.")).toBe("Use **bold** later\nMore.");
  // A title line too long to show whole stays in the body.
  const long = `**${"x".repeat(97)}**\nBody`;
  expect(bodyOf(long)).toBe(long);
  // A configured title leaves the content whole.
  expect(bodyOf("# Heading\nBody", { title: "Configured" })).toBe("# Heading\nBody");
});
