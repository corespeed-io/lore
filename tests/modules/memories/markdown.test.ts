import type { Token } from "markdown-it";
import { expect, test } from "vitest";
import {
  allowedHref,
  hasVisibleText,
  MAXIMUM_MARKDOWN_NESTING,
  MAXIMUM_TABLE_CELLS,
  type MarkdownNode,
  type MarkdownProps,
  type MarkdownTag,
  memoryMarkdown,
  memoryMarkdownTree,
  nodeText,
  parseMemoryMarkdown,
  tableRowCells,
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

test("a wikilink copied from a table into prose keeps its escaped pipe as the separator", () => {
  expect(inline("See [[ops/ch\\|ClickHouse]]")).toEqual([
    ["text", "See "],
    { wikilink: "ops/ch", label: "ClickHouse" },
  ]);
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
  // markdown-it percent-encodes a target before the check, so a backslash never
  // reaches the browser as a path separator in the host.
  expect(inline("[x](http://\\evil.test)")).toEqual([
    ["link_open", "http://%5Cevil.test"],
    ["text", "x"],
    "link_close",
  ]);
  // An image source passes the same check.
  expect(types("![x](data:image/png;base64,AAAA)")).not.toContain("image");
  expect(types("![x](https://example.test/x.png)")).toContain("image");
});

test("a reference definition and a reference link stay text a reader can see", () => {
  const tokens = memoryMarkdown.parse(
    'Visible fact.\n\n[x]: https://example.test "hidden title"\n\nSee [a][x] and [x].',
    {},
  );
  const text = tokens
    .flatMap((token) => token.children ?? [])
    .filter((token) => token.type === "text")
    .map((token) => token.content)
    .join(" ");

  expect(text).toContain('[x]: https://example.test "hidden title"');
  expect(text).toContain("See [a][x] and [x].");
  expect(tokens.flatMap((token) => token.children ?? []).map((token) => token.type)).not.toContain(
    "link_open",
  );
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

/** A table of `columns` columns and `rows` rows, the header row included. */
function table(columns: number, rows: number): string {
  return [`|${" a |".repeat(columns)}`, `|${" - |".repeat(columns)}`]
    .concat(Array.from({ length: rows - 1 }, () => `|${" 1 |".repeat(columns)}`))
    .join("\n");
}

function tableCells(tokens: readonly Token[] | null): number {
  return (tokens ?? []).filter((token) => token.type === "td_open" || token.type === "th_open")
    .length;
}

test("the tables of one body share the cell budget, the cells markdown-it fills in too", () => {
  const filled = parseMemoryMarkdown("| a | b | c |\n| - | - | - |\n| 1 |\n| 2 | 3 |");
  expect(tableCells(filled)).toBe(9);

  // 50 columns by 100 rows spends the budget exactly, and still renders.
  const exact = parseMemoryMarkdown(table(50, 100));
  expect(tableCells(exact)).toBe(MAXIMUM_TABLE_CELLS);

  // One more row goes past it: that table and every later one stay paragraph text.
  const past = parseMemoryMarkdown(`${table(2, 2)}\n\n${table(50, 101)}\n\n${table(2, 2)}`);
  expect(tableCells(past)).toBe(4);
  expect(past?.filter((token) => token.type === "table_open")).toHaveLength(1);
  expect(past?.filter((token) => token.type === "paragraph_open")).toHaveLength(2);
});

test("a body cannot parse to more table cells than the budget, however few its characters", () => {
  // Each table fills in about 66,000 cells from 1,260 characters.
  const filling = `|${"|".repeat(209)}\n|${"-|".repeat(209)}\n${"a\n".repeat(315)}\n`;
  const started = performance.now();
  const tokens = parseMemoryMarkdown(filling.repeat(25));

  expect(tableCells(tokens)).toBeLessThanOrEqual(MAXIMUM_TABLE_CELLS);
  expect(tokens?.length ?? 0).toBeLessThan(1_000);
  expect(performance.now() - started).toBeLessThan(500);
});

test("inline markup nested past the bound renders as text too", () => {
  const nested = (depth: number) => `${"*a _a ".repeat(depth)}x${" a_ a*".repeat(depth)}`;

  expect(parseMemoryMarkdown(nested(20))).not.toBeNull();
  expect(parseMemoryMarkdown(nested(2_500))).toBeNull();
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

function el(tag: MarkdownTag, children: MarkdownNode[], props: MarkdownProps = {}): MarkdownNode {
  return { kind: "element", tag, props, children };
}

const web = (href: string, title?: string): MarkdownProps => ({
  className: "ext",
  href,
  ...(title ? { title } : {}),
  target: "_blank",
  rel: "noopener noreferrer",
});

/** The nodes one paragraph renders. */
function paragraphOf(markdown: string): MarkdownNode[] {
  const [paragraph] = memoryMarkdownTree(markdown) ?? [];
  if (typeof paragraph !== "object" || paragraph.kind !== "element" || paragraph.tag !== "p") {
    throw new Error(`not one paragraph: ${JSON.stringify(paragraph)}`);
  }
  return paragraph.children;
}

test("a link renders one anchor, and shows its target when it shows no text", () => {
  // An autolink in a link label is its text, never a second anchor.
  expect(paragraphOf("[see <https://x.test>](https://y.test)")).toEqual([
    el("a", ["see ", "https://x.test"], web("https://y.test")),
  ]);
  for (const empty of ["[](https://y.test)", "[ ](https://y.test)", "[&#8203;](https://y.test)"]) {
    expect(paragraphOf(empty)).toEqual([el("a", ["https://y.test"], web("https://y.test"))]);
  }
  expect(paragraphOf("[*&#8203;*](https://y.test)")).toEqual([
    el("a", ["https://y.test"], web("https://y.test")),
  ]);
  // A title shows on hover, and mailto opens in place.
  expect(paragraphOf('[docs](https://y.test "Docs")')).toEqual([
    el("a", ["docs"], web("https://y.test", "Docs")),
  ]);
  expect(paragraphOf("[mail](mailto:a@example.test)")).toEqual([
    el("a", ["mail"], { className: "ext", href: "mailto:a@example.test" }),
  ]);
});

test("an image is a link to its source, and inside a link its source shows on hover", () => {
  expect(paragraphOf('![chart](https://x.test/c.png "Q3 restated")')).toEqual([
    el("a", ["chart"], web("https://x.test/c.png", "Q3 restated")),
  ]);
  expect(paragraphOf("![ ](https://x.test/a.png)")).toEqual([
    el("a", ["https://x.test/a.png"], web("https://x.test/a.png")),
  ]);
  // Wikilink labels and link targets inside the alt text still read.
  expect(nodeText(paragraphOf("![Diagram of [[Alpha]] flow](https://x.test/i.png)"))).toBe(
    "Diagram of Alpha flow",
  );
  expect(nodeText(paragraphOf("![see [docs](https://evil.test/x)](https://x.test/a.png)"))).toBe(
    "see docs (https://evil.test/x)",
  );
  expect(paragraphOf("[![logo](https://x.test/l.png)](https://d.test)")).toEqual([
    el("a", [el("span", ["logo"], { title: "https://x.test/l.png" })], web("https://d.test")),
  ]);
});

test("a wikilink with no visible label shows its reference, and inside a link reads as text", () => {
  expect(paragraphOf("[[ops/ch|\u200b]]")).toEqual([
    { kind: "wikilink", reference: "ops/ch", label: "ops/ch" },
  ]);
  // A label is source text, so an entity in it reads as written.
  expect(paragraphOf("[[ops/ch|&#8203;]]")).toEqual([
    { kind: "wikilink", reference: "ops/ch", label: "&#8203;" },
  ]);
  expect(paragraphOf("[see [[ops/ch|ClickHouse]]](https://y.test)")).toEqual([
    "[see ",
    { kind: "wikilink", reference: "ops/ch", label: "ClickHouse" },
    "](https://y.test)",
  ]);
});

test("the body renders its blocks under the page title's own heading", () => {
  expect(memoryMarkdownTree("# A\n## B\n### C\n#### D\n##### E")).toEqual([
    el("h2", ["A"]),
    el("h2", ["B"]),
    el("h3", ["C"]),
    el("h4", ["D"]),
    el("h4", ["E"]),
  ]);
  // A tight list shows no paragraphs; a loose one does.
  expect(memoryMarkdownTree("- a\n- b")).toEqual([el("ul", [el("li", ["a"]), el("li", ["b"])])]);
  expect(memoryMarkdownTree("- a\n\n- b")).toEqual([
    el("ul", [el("li", [el("p", ["a"])]), el("li", [el("p", ["b"])])]),
  ]);
  expect(memoryMarkdownTree("3. c\n4. d")).toEqual([
    el("ol", [el("li", ["c"]), el("li", ["d"])], { start: 3 }),
  ]);
  // A fence shows its info string above its code.
  expect(memoryMarkdownTree("```ts ignore previous\nx\n```")).toEqual([
    el(
      "pre",
      [el("span", ["ts ignore previous"], { className: "fence-info" }), el("code", ["x\n"])],
      { className: "fence" },
    ),
  ]);
  expect(memoryMarkdownTree("| a | b |\n| :-: | --: |\n| 1 | 2 |")).toEqual([
    el("table", [
      el("thead", [
        el("tr", [
          el("th", ["a"], { className: "align-center" }),
          el("th", ["b"], { className: "align-right" }),
        ]),
      ]),
      el("tbody", [
        el("tr", [
          el("td", ["1"], { className: "align-center" }),
          el("td", ["2"], { className: "align-right" }),
        ]),
      ]),
    ]),
  ]);
});

test("a table with a row longer than its header stays text, so no cell is dropped", () => {
  const tree = memoryMarkdownTree("| a |\n|---|\n| shown | extra cell |");

  expect(JSON.stringify(tree)).not.toContain('"table"');
  expect(nodeText(tree ?? [])).toContain("extra cell");
  // A row that stops short is filled in instead, and still renders as a table.
  expect(JSON.stringify(memoryMarkdownTree("| a | b |\n|---|---|\n| shown |"))).toContain(
    '"table"',
  );
});

test("a table row counts its cells as markdown-it does", () => {
  expect(tableRowCells("| a |")).toBe(1);
  expect(tableRowCells("a | b")).toBe(2);
  expect(tableRowCells("| a | \\| b |")).toBe(2);
  expect(tableRowCells("| a | |")).toBe(2);
  expect(tableRowCells("  a  ")).toBe(1);
  expect(tableRowCells("|")).toBe(0);
});

test("visible text is a letter, digit, punctuation, or symbol", () => {
  for (const text of ["a", "中", "—", "😀", "1"]) expect(hasVisibleText(text)).toBe(true);
  for (const text of ["", " ", "\u00a0", "\u200b", "\u00ad", "\u2060"]) {
    expect(hasVisibleText(text)).toBe(false);
  }
});
