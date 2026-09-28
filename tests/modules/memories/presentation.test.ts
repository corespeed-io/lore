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
  // Underscore emphasis reads as its words, as the body renders it, but an
  // underscore inside a word and a lone asterisk are text.
  expect(titleOf("__init__.py loads a * b")).toBe("init.py loads a * b");
  expect(titleOf("## Rename snake_case_name, _then_ ship")).toBe(
    "Rename snake_case_name, then ship",
  );
  expect(titleOf("# 中文_注意_中文")).toBe("中文_注意_中文");
  // A configured title shows its text, as a first line does.
  expect(memoryTitle(memory({ content: "**x**", metadata: { title: "## **Set** title" } }))).toBe(
    "Set title",
  );
  // A configured title that is only markup still shows what was set.
  expect(memoryTitle(memory({ content: "x", metadata: { title: "****" } }))).toBe("****");
  // However long a configured title is, the title shows at most the limit.
  expect(memoryTitle(memory({ metadata: { title: "**".repeat(4_000) } }))).toBe(
    `${"*".repeat(95)}…`,
  );
});

test("plain text keeps a code span as written and drops the rest of the inline markup", () => {
  expect(plainInline("Run `**not bold**` and `[[not|link]]`")).toBe(
    "Run **not bold** and [[not|link]]",
  );
  // Strikethrough keeps its markers, the only sign that its words are struck.
  expect(plainInline("See ![the chart](https://example.test/c.png) and ~~old~~ *new*")).toBe(
    "See the chart and ~~old~~ new",
  );
  // A link with a title or with parentheses in its target reads as its label.
  expect(plainInline('See [docs](https://example.test "Docs") now')).toBe("See docs now");
  expect(plainInline("See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) now")).toBe("See Foo now");
  expect(plainInline("See [x](<https://example.test/a>) now")).toBe("See x now");
  // An escape reads as the character it escapes, and common entities decode.
  expect(plainInline("Use \\*args\\* and \\_x\\_ or \\[[not a link]]")).toBe(
    "Use *args* and _x_ or [[not a link]]",
  );
  expect(plainInline("AT&amp;T &lt;tag&gt; &#8212; &#x41; &#0; &nbsp;")).toBe(
    "AT&T <tag> — A \ufffd &nbsp;",
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
    "_a".repeat(16_000),
    "`".repeat(32_000),
    "[a](http://(".repeat(2_600),
    '[a](https://x "'.repeat(2_000),
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
  const kept = (content: string) => expect(bodyOf(content)).toBe(content);

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

  // Every other link form, including autolinks and reference links.
  kept("# See <https://example.test/runbook>\nBody");
  kept("**Ask <team@example.test>**\nBody");
  kept("## See [the runbook][rb]\n\n[rb]: https://example.test/rb");
  // Markup whose plain text reads differently: strikethrough, escapes, entities,
  // and an asterisk the title cannot pair.
  kept("**Note** ~~old~~\nBody");
  kept("# AT&amp;T \\*escaped\\*\nBody");
  kept("# Python **kwargs and *args\nBody");
  // A line that alone would open indented code or a later-numbered list, where
  // under the title it was the title's paragraph.
  kept("**Deploy steps**\n    ssh prod && ./deploy.sh\ncontinues");
  kept("【标题】\n\t缩进");
  kept("**Owners**\n2. Alice\n3. Bob");
  kept("**Owners**\n1.\nnext");
  kept("**Owners**\n2) Bob");
  kept("**Owners**\n1)\nnext");
  kept("**Owners**\n*\nnext");
  kept("**Owners**\n+");
  // A line shaped like a reference definition is text either way.
  expect(bodyOf("**Links**\n[rb]: https://example.test/rb")).toBe("[rb]: https://example.test/rb");
  // A list that may interrupt a paragraph parses the same either way.
  expect(bodyOf("**Owners**\n1. Alice")).toBe("1. Alice");
  expect(bodyOf("__Title__\nBody")).toBe("Body");
});

test("an escaped or encoded title reads as the body renders it", () => {
  expect(memoryTitle(memory({ content: "# AT&amp;T \\*escaped\\*\nBody" }))).toBe("AT&T *escaped*");
});

test("an entity past Unicode, or a lone surrogate, reads as a replacement character", () => {
  // String.fromCodePoint throws on these, and labels of every Graph node pass through here.
  expect(plainInline("a &#9999999; b &#xFFFFFF; c &#xD800; d &#1114112;")).toBe(
    "a \ufffd b \ufffd c \ufffd d \ufffd",
  );
  expect(memoryTitle(memory({ content: "# &#1114112;\nBody" }))).toBe("\ufffd");
});

test("the body keeps a first line longer than the title reads", () => {
  const content = `## ${"**".repeat(500)}${"real text ".repeat(100)}\nBody`;
  expect(memoryBody(memory({ content }))).toBe(content);
  // Without markup the title shows only the words before the bound, so the rest stays.
  const padded = `# Deploy${" ".repeat(1_000)}only after the freeze lifts\nBody`;
  expect(memoryBody(memory({ content: padded }))).toBe(padded);
});

test("spaced asterisks and underscores are not emphasis in a title", () => {
  expect(plainInline("Budget = 2 * 3 * 4 hours")).toBe("Budget = 2 * 3 * 4 hours");
  expect(plainInline("a _ b _ c and a __ b __ c")).toBe("a _ b _ c and a __ b __ c");
  const content = "# Budget = 2 * 3 * 4 hours\nBody";
  expect(memoryTitle(memory({ content }))).toBe("Budget = 2 * 3 * 4 hours");
  expect(memoryBody(memory({ content }))).toBe(content);
});

test("deciding whether a title line continues takes linear time", () => {
  const cells = `-${`${" ".repeat(1_100)}|-`.repeat(26)}${" ".repeat(1_100)}x`;
  const started = performance.now();
  // Not a delimiter row, so the body starts after the title line.
  expect(memoryBody(memory({ content: `**Note**\n${cells}` }))).toBe(cells);
  // Indented, so it would open a code block without the title line, which stays.
  const indented = `**Note**\n${" ".repeat(1_100)}${cells}`;
  expect(memoryBody(memory({ content: indented }))).toBe(indented);
  expect(performance.now() - started).toBeLessThan(100);
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
