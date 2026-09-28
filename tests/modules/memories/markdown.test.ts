import type { Token } from "markdown-it";
import { expect, test } from "vitest";
import {
  allowedHref,
  MAXIMUM_MARKDOWN_NESTING,
  memoryMarkdown,
  parseMemoryMarkdown,
  tableExtent,
  wikilinkTarget,
} from "@/modules/memories/browser/markdown";

const TARGET_MEMORY_ID = "e6f22a12-8b29-57ef-bbdf-ce11121303c7";

type Rendered = string | [string, string] | { wikilink: string; label: string };

/** The inline tokens a line of prose parses to, reduced to what the renderer reads. */
function inline(markdown: string): Rendered[] {
  return (memoryMarkdown.parseInline(markdown, {})[0]?.children ?? []).map(reduced);
}

function reduced(token: Token): Rendered {
  if (token.type === "wikilink") {
    return {
      wikilink: String(token.meta?.reference),
      label: String(token.meta?.label),
    };
  }
  if (token.type === "text" || token.type === "code_inline") return [token.type, token.content];
  if (token.type === "link_open") return ["link_open", String(token.attrGet("href"))];
  return token.type;
}

/** Every token type a body parses to, block and inline. */
function types(markdown: string): string[] {
  return memoryMarkdown
    .parse(markdown, {})
    .flatMap((token) => [token.type, ...(token.children ?? []).map((child) => child.type)]);
}

test("wikilinks in prose become wikilink tokens with their label", () => {
  expect(inline("See [[topic/retrieval/specs|technical specs]] and [[plain]]")).toEqual([
    ["text", "See "],
    { wikilink: "topic/retrieval/specs", label: "technical specs" },
    ["text", " and "],
    { wikilink: "plain", label: "plain" },
  ]);
});

test("code keeps its brackets, in a span or a fence", () => {
  expect(inline("`[[not a link]]`")).toEqual([["code_inline", "[[not a link]]"]]);
  const [fence] = memoryMarkdown.parse("```\n[[also code]]\n```", {});
  expect(fence).toMatchObject({ type: "fence", content: "[[also code]]\n" });
});

test("a wikilink trims its reference and label, and a blank label shows the reference", () => {
  expect(inline("[[ topic/a | Label ]]")).toEqual([{ wikilink: "topic/a", label: "Label" }]);
  expect(inline("[[topic/a|   ]]")).toEqual([{ wikilink: "topic/a", label: "topic/a" }]);
  // Only the first `|` separates the reference from its label.
  expect(inline("[[a|b|c]]")).toEqual([{ wikilink: "a", label: "b|c" }]);
});

test("a wikilink never spans a line break, and a blank part is not a wikilink", () => {
  expect(inline("[[topic\nnext]]")).toEqual([["text", "[[topic"], "softbreak", ["text", "next]]"]]);
  expect(inline("[[topic|]]")).toEqual([["text", "[[topic|]]"]]);
  expect(inline("[[ ]] then [[a]][[b]]")).toEqual([
    ["text", "[[ ]] then "],
    { wikilink: "a", label: "a" },
    { wikilink: "b", label: "b" },
  ]);
});

test("a wikilink claims its brackets before links and emphasis can", () => {
  expect(inline("[[*a*]]")).toEqual([{ wikilink: "*a*", label: "*a*" }]);
  expect(inline("[[a]](https://example.test)")).toEqual([
    { wikilink: "a", label: "a" },
    ["text", "(https://example.test)"],
  ]);
  // A single bracket is Markdown's, so a task marker stays text.
  expect(inline("[x] done")).toEqual([["text", "[x] done"]]);
});

test("every wikilink reference reaches the renderer as written", () => {
  for (const reference of ["a b", "100%", "a#b?c=d", "AT&T", "路径/笔记", "a+b", "%E0%A4"]) {
    expect(inline(`[[${reference}]]`)).toEqual([{ wikilink: reference, label: reference }]);
  }
});

test("in a table a wikilink label needs its pipe escaped", () => {
  const tokens = memoryMarkdown.parse(
    "| note | link |\n| --- | --- |\n| a | [[ops/ch\\|ClickHouse]] |",
    {},
  );
  const cells = tokens
    .filter((token) => token.type === "inline")
    .flatMap((token) => token.children);

  expect(cells.filter((token) => token?.type === "wikilink").map((token) => token?.meta)).toEqual([
    { reference: "ops/ch", label: "ClickHouse" },
  ]);
});

test("a Memory body links only to http(s) with a host, and to mailto", () => {
  for (const url of [
    "https://example.test/a",
    "http://example.test",
    "HTTPS://EXAMPLE.TEST/A",
    "mailto:a@example.test",
    "MAILTO:a@example.test",
  ]) {
    expect(allowedHref(url)).toBe(true);
  }
  for (const url of [
    "javascript:alert(1)",
    " JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:x",
    "https:/api",
    "https:///path",
    "http://\\evil.test",
    "mailto:",
    "/memories",
    "relative/path",
    "",
  ]) {
    expect(allowedHref(url)).toBe(false);
  }
});

test("a link to any other target stays text", () => {
  expect(inline("[x](javascript:alert(1)) [y](https:/api)")).toEqual([
    ["text", "[x](javascript:alert(1)) [y](https:/api)"],
  ]);
  expect(inline("[z](https://example.test)")).toEqual([
    ["link_open", "https://example.test"],
    ["text", "z"],
    "link_close",
  ]);
  // An image source passes the same check.
  expect(types("![x](data:image/png;base64,AAAA)")).not.toContain("image");
  expect(types("![x](https://example.test/x.png)")).toContain("image");
});

test("raw HTML and bare URLs stay text", () => {
  const parsed = types("<b>bold</b>\n\n<div>block</div>\n\nwww.example.test https://example.test");

  expect(parsed).not.toContain("html_inline");
  expect(parsed).not.toContain("html_block");
  expect(parsed).not.toContain("link_open");
});

test("a Memory keeps each line break, whatever the line ending", () => {
  for (const markdown of ["one\ntwo", "one\r\ntwo", "one\rtwo"]) {
    const children = memoryMarkdown.parse(markdown, {})[1]?.children ?? [];
    expect(children.map(reduced)).toEqual([["text", "one"], "softbreak", ["text", "two"]]);
  }
});

test("lists, quotes, tables, and strikethrough keep their structure", () => {
  const parsed = types("1. first\n   - nested\n\n> quote\n\n| a |\n| - |\n| b |\n\n~~gone~~");

  for (const type of [
    "ordered_list_open",
    "bullet_list_open",
    "list_item_open",
    "blockquote_open",
    "table_open",
    "th_open",
    "td_open",
    "s_open",
  ]) {
    expect(parsed).toContain(type);
  }
});

test("a body that nests past the bound renders as text rather than losing its end", () => {
  const quoted = (depth: number) => `${">".repeat(depth)} deep`;
  const deepest = parseMemoryMarkdown(quoted(MAXIMUM_MARKDOWN_NESTING - 1));

  expect(deepest?.some((token) => token.children?.some((child) => child.content === "deep"))).toBe(
    true,
  );
  expect(parseMemoryMarkdown(quoted(MAXIMUM_MARKDOWN_NESTING))).toBeNull();
  // Each list level costs two, so an outline 40 levels deep still renders.
  const outline = (depth: number) =>
    Array.from({ length: depth }, (_, level) => `${"  ".repeat(level)}- item ${level}`).join("\n");
  expect(parseMemoryMarkdown(outline(40))).not.toBeNull();
  expect(parseMemoryMarkdown(outline(60))).toBeNull();
});

test("a table's extent counts every cell, including the ones markdown-it fills in", () => {
  const tokens = memoryMarkdown.parse(
    "| a | b | c |\n| - | - | - |\n| 1 |\n| 2 | 3 |\n\nafter",
    {},
  );
  const start = tokens.findIndex((token) => token.type === "table_open");
  const { end, cells } = tableExtent(tokens, start);

  expect(tokens[end]?.type).toBe("table_close");
  expect(cells).toBe(9);
  expect(tokens[end + 1]?.type).toBe("paragraph_open");
});

test("parsing costs linear time on hostile bodies", () => {
  for (const input of [
    "> ".repeat(16_000),
    "- ".repeat(16_000),
    "*a".repeat(16_000),
    "_a".repeat(16_000),
    "[[".repeat(16_000),
    "[[a".repeat(10_000),
    `${"[".repeat(8_000)}a${"](https://x)".repeat(2_000)}`,
    `|${"a|".repeat(3_000)}\n|${"-|".repeat(3_000)}\n${"a\n".repeat(10_000)}`,
  ]) {
    const started = performance.now();
    parseMemoryMarkdown(input.slice(0, 32_000));
    expect(performance.now() - started).toBeLessThan(500);
  }
});

test("a wikilink resolves only through the map's own properties", () => {
  expect(wikilinkTarget({ "topic/specs": TARGET_MEMORY_ID }, "topic/specs")).toBe(TARGET_MEMORY_ID);
  expect(wikilinkTarget({}, "constructor")).toBeUndefined();
  expect(wikilinkTarget({}, "__proto__")).toBeUndefined();
  expect(wikilinkTarget({ empty: "" }, "empty")).toBeUndefined();
  const targets = Object.create(null) as Record<string, string>;
  Object.defineProperty(targets, "constructor", { value: TARGET_MEMORY_ID, enumerable: true });
  expect(wikilinkTarget(targets, "constructor")).toBe(TARGET_MEMORY_ID);
});

test("a target that is not an id string resolves to nothing", () => {
  const malformed = { count: 42, list: [TARGET_MEMORY_ID] } as unknown as Record<string, string>;
  expect(wikilinkTarget(malformed, "count")).toBeUndefined();
  expect(wikilinkTarget(malformed, "list")).toBeUndefined();
});
