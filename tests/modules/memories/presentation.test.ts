import type { Memory } from "@corespeed/lore-sdk";
import { expect, test, vi } from "vitest";
import {
  memoryBody,
  memoryConfiguredType,
  memoryTitle,
  memoryType,
  plain,
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
  // A configured title shows its text, as a first line does.
  expect(memoryTitle(memory({ content: "**x**", metadata: { title: "## **Set** title" } }))).toBe(
    "Set title",
  );
  // A configured title that is only markup still shows what was set.
  expect(memoryTitle(memory({ content: "x", metadata: { title: "****" } }))).toBe("****");
});

test("plain text keeps a code span as written and drops the rest of the inline markup", () => {
  expect(plainInline("Run `**not bold**` and `[[not|link]]`")).toBe(
    "Run **not bold** and [[not|link]]",
  );
  expect(plainInline("See ![the chart](https://example.test/c.png) and ~~old~~ *new*")).toBe(
    "See the chart and old new",
  );
  // A heading marker goes only at the start, and a link to another scheme stays.
  expect(plainInline("# Title # not a marker")).toBe("Title # not a marker");
  expect(plainInline("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
});

test("plain text costs linear time on runs of brackets and markers", () => {
  for (const input of [
    "[".repeat(32_000),
    "[[a|".repeat(8_000),
    "![".repeat(16_000),
    "[a](".repeat(8_000),
    "*a".repeat(16_000),
    "`".repeat(32_000),
  ]) {
    const started = performance.now();
    plainInline(input);
    plain(input);
    memoryTitle(memory({ content: input }));
    memoryBody(memory({ content: input }));
    // The quadratic patterns these replace took seconds on the same inputs.
    expect(performance.now() - started).toBeLessThan(250);
  }
});

test("a search snippet drops fences and block markers as well as inline markup", () => {
  expect(plain("# H\n**b** [[a/b|c]] `x`")).toBe("H b c x");
  expect(plain("> quoted\n- item\n2) second\n```ts\nconst x = 1;\n```\nend")).toBe(
    "quoted item second end",
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
  expect(bodyOf("**Prefer code** (2026-09-18, review)\nBody")).toBe("Body");
  expect(bodyOf("【规范】（适用范围）\n正文")).toBe("正文");
  // A plain first line may open a paragraph, so it stays.
  expect(bodyOf("A durable fact.\nMore.")).toBe("A durable fact.\nMore.");
  expect(bodyOf("Use **bold** later\nMore.")).toBe("Use **bold** later\nMore.");
  // A title line too long to show whole stays in the body.
  const long = `**${"x".repeat(97)}**\nBody`;
  expect(bodyOf(long)).toBe(long);
  // A configured title leaves the content whole.
  expect(bodyOf("# Heading\nBody", { title: "Configured" })).toBe("# Heading\nBody");
  // A lone carriage return ends a line too.
  expect(bodyOf("**Title**\rBody")).toBe("Body");
});

test("the body keeps a title line the renderer reads as more than a title", () => {
  const bodyOf = (content: string) => memoryBody(memory({ content }));

  // The next line makes it a table header or a setext heading.
  const table = "**Col** | Other\n| --- | --- |\n| a | b |";
  expect(bodyOf(table)).toBe(table);
  const setext = "**Title**\n===\nBody";
  expect(bodyOf(setext)).toBe(setext);
  // A link the title cannot follow stays where it can be clicked.
  const linked = "**See [the runbook](https://example.test)**\nBody";
  expect(bodyOf(linked)).toBe(linked);
  const wikilinked = "## [[ops/ch|ClickHouse]]\nBody";
  expect(bodyOf(wikilinked)).toBe(wikilinked);
  // An ATX heading ends at its line, so a rule under it is the body's own.
  expect(bodyOf("# Title\n---\nBody")).toBe("---\nBody");
});

test("a wikilink without a label reads as its reference", () => {
  expect(plainInline("Mail [the team](mailto:team@example.test)")).toBe("Mail the team");
  expect(plainInline("See [[ops/clickhouse]] and [[ops/ch|ClickHouse]]")).toBe(
    "See ops/clickhouse and ClickHouse",
  );
});

test("a blank or non-text configured title falls back to the first line, then to Untitled", () => {
  expect(memoryTitle(memory({ content: "# Heading\nBody", metadata: { title: "   " } }))).toBe(
    "Heading",
  );
  expect(memoryTitle(memory({ content: "First line", metadata: { title: 42 } }))).toBe(
    "First line",
  );
  expect(memoryTitle(memory({ content: "" }))).toBe("Untitled memory");
  // A first line that is only markup has no words to show.
  expect(memoryTitle(memory({ content: "# \nBody" }))).toBe("Untitled memory");
  expect(memoryTitle(memory({ content: "****\nBody" }))).toBe("Untitled memory");
});

test("the title shows a first line whole only up to the limit, and the body agrees", () => {
  const whole = "x".repeat(96);
  expect(memoryTitle(memory({ content: `**${whole}**\nBody` }))).toBe(whole);
  expect(memoryBody(memory({ content: `**${whole}**\nBody` }))).toBe("Body");

  const cut = `**${"x".repeat(97)}**\nBody`;
  const cutTitle = memoryTitle(memory({ content: cut }));
  expect(cutTitle).toBe(`${"x".repeat(95)}…`);
  expect(memoryBody(memory({ content: cut }))).toBe(cut);

  // Runs of whitespace count once, as the title shows them.
  const spaced = `# ${"ab   ".repeat(30).trim()}\nBody`;
  expect(memoryTitle(memory({ content: spaced })).endsWith("…")).toBe(false);
  expect(memoryBody(memory({ content: spaced }))).toBe("Body");
});

test("only a heading, a bold run, or a 【…】 run opens a title line", () => {
  const bodyOf = (content: string) => memoryBody(memory({ content }));

  expect(bodyOf("**【规范】 适用范围\n正文")).toBe("正文");
  expect(bodyOf("#\tTabbed heading\nBody")).toBe("Body");
  // A hashtag, or seven hashes, is not a Markdown heading.
  expect(bodyOf("#tag first\nBody")).toBe("#tag first\nBody");
  expect(bodyOf("####### seven\nBody")).toBe("####### seven\nBody");
  // An unclosed bold run is not a title.
  expect(bodyOf("**unclosed title\nBody")).toBe("**unclosed title\nBody");
});
