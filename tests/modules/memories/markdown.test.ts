import { expect, test } from "vitest";
import {
  allowedHref,
  keepsBrowserClick,
  MAXIMUM_MARKDOWN_NESTING,
  MAXIMUM_TABLE_CELLS,
  parseMemoryMarkdown,
  renderMemoryMarkdown,
  wikilinkTarget,
} from "@/modules/memories/browser/markdown";

const TARGET_MEMORY_ID = "e6f22a12-8b29-57ef-bbdf-ce11121303c7";
const EXTERNAL = 'target="_blank" rel="noopener noreferrer"';

/** A body's HTML, or null when it renders as its text. */
function html(markdown: string, targets: Record<string, string> = {}): string | null {
  const tokens = parseMemoryMarkdown(markdown);
  return tokens && renderMemoryMarkdown(tokens, targets, "not found");
}

function cells(markdown: string): number {
  return (html(markdown)?.match(/<t[hd][ >]/g) ?? []).length;
}

test("a Memory body keeps its paragraphs and each line break, whatever the line ending", () => {
  expect(html("one\ntwo\n\nthree")).toBe("<p>one<br>\ntwo</p>\n<p>three</p>\n");
  expect(html("one\r\ntwo")).toBe(html("one\rtwo"));
  expect(html("one\rtwo")).toBe("<p>one<br>\ntwo</p>\n");
});

test("wikilinks resolve to Memory links, and an unresolved one names its reference on hover", () => {
  const targets = { "ops/ch": TARGET_MEMORY_ID };

  expect(html("See [[ops/ch|ClickHouse]] and [[missing]]", targets)).toBe(
    `<p>See <a class="wl" href="/memory/${TARGET_MEMORY_ID}" data-memory-id="${TARGET_MEMORY_ID}" title="ops/ch">ClickHouse</a>` +
      ' and <span class="wl-unresolved" title="missing — not found">missing</span></p>\n',
  );
  // A label that is its reference needs no hover.
  expect(html("[[ops/ch]]", targets)).toContain(`data-memory-id="${TARGET_MEMORY_ID}">ops/ch</a>`);
  // Code keeps its brackets.
  expect(html("`[[ops/ch]]`\n\n```\n[[ops/ch]]\n```", targets)).not.toContain("wl");
});

test("a wikilink trims its parts, takes the first pipe, and never spans a line", () => {
  expect(html("[[ a | Label ]]")).toContain('title="a — not found">Label</span>');
  expect(html("[[a|   ]]")).toContain(">a</span>");
  expect(html("[[a|b|c]]")).toContain(">b|c</span>");
  expect(html("[[topic\nnext]]")).toBe("<p>[[topic<br>\nnext]]</p>\n");
  expect(html("[[ ]] and [[a|]]")).toBe("<p>[[ ]] and [[a|]]</p>\n");
  // It claims its brackets before emphasis can.
  expect(html("[[*a*]]")).toContain(">*a*</span>");
  // A table cell escapes the label's pipe, and prose may carry the escape too.
  for (const markdown of ["| a |\n| - |\n| [[ops/ch\\|ClickHouse]] |", "[[ops/ch\\|ClickHouse]]"]) {
    expect(html(markdown)).toContain('title="ops/ch — not found">ClickHouse</span>');
  }
});

test("a wikilink's reference and label are escaped wherever they reach the page", () => {
  const rendered = html('[[a"><img src=x onerror=alert(1)>|<b>x</b>]]') ?? "";

  expect(rendered).not.toContain("<img");
  expect(rendered).not.toContain("<b>");
  expect(rendered).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(rendered).toContain('title="a&quot;&gt;&lt;img');
});

test("a wikilink resolves only through the map's own properties", () => {
  expect(wikilinkTarget({ "topic/specs": TARGET_MEMORY_ID }, "topic/specs")).toBe(TARGET_MEMORY_ID);
  expect(wikilinkTarget({}, "constructor")).toBeUndefined();
  expect(wikilinkTarget({}, "__proto__")).toBeUndefined();
  expect(wikilinkTarget({ empty: "" }, "empty")).toBeUndefined();
  const malformed = { count: 42 } as unknown as Record<string, string>;
  expect(wikilinkTarget(malformed, "count")).toBeUndefined();
});

test("a Memory body links only to http(s) with a host, and to mailto", () => {
  for (const url of ["https://example.test/a", "HTTP://EXAMPLE.TEST", "mailto:a@example.test"]) {
    expect(allowedHref(url)).toBe(true);
  }
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https:/api",
    "https:///path",
    "mailto:",
    "/memories",
    "",
  ]) {
    expect(allowedHref(url)).toBe(false);
  }
  expect(html("[x](javascript:alert(1)) [y](https:/api) ![z](data:image/png;base64,AA)")).toBe(
    "<p>[x](javascript:alert(1)) [y](https:/api) ![z](data:image/png;base64,AA)</p>\n",
  );
  // markdown-it skips the check for an empty target, so the renderer checks again.
  expect(html("[a]() [b]( ) ![c]() x![]()y")).toBe("<p>a b c xy</p>\n");
});

test("a link opens in a new tab, mailto in place, and a title shows on hover", () => {
  expect(html('[docs](https://y.test "Docs")')).toBe(
    `<p><a class="ext" href="https://y.test" title="Docs" ${EXTERNAL}>docs</a></p>\n`,
  );
  expect(html("[mail](mailto:a@example.test)")).toBe(
    '<p><a class="ext" href="mailto:a@example.test">mail</a></p>\n',
  );
  // An autolink in a link label is its text, never a second anchor.
  expect(html("[see <https://x.test>](https://y.test)")).toBe(
    `<p><a class="ext" href="https://y.test" ${EXTERNAL}>see https://x.test</a></p>\n`,
  );
});

test("an image is a link to its source, never a remote load", () => {
  expect(html('![chart](https://x.test/c.png "Q3")')).toBe(
    `<p><a class="ext" href="https://x.test/c.png" title="Q3" ${EXTERNAL}>chart</a></p>\n`,
  );
  // With no alt text it shows its source; inside a link, its words.
  expect(html("![](https://x.test/a.png)")).toContain(">https://x.test/a.png</a>");
  expect(html("[![logo](https://x.test/l.png)](https://d.test)")).toBe(
    `<p><a class="ext" href="https://d.test" ${EXTERNAL}>logo</a></p>\n`,
  );
  expect(html("![x](https://x.test/p.png)")).not.toContain("<img");
});

test("raw HTML, bare URLs, and reference definitions stay text a reader can see", () => {
  expect(html("<b>bold</b> <script>x</script> www.example.test https://example.test")).toBe(
    "<p>&lt;b&gt;bold&lt;/b&gt; &lt;script&gt;x&lt;/script&gt; www.example.test https://example.test</p>\n",
  );
  expect(html('Fact.\n\n[x]: https://example.test "hidden"\n\nSee [a][x].')).toBe(
    "<p>Fact.</p>\n<p>[x]: https://example.test &quot;hidden&quot;</p>\n<p>See [a][x].</p>\n",
  );
});

test("headings sit under the page title, and every block keeps its element", () => {
  expect(html("# A\n## B\n### C\n#### D\n###### E")).toBe(
    "<h2>A</h2>\n<h2>B</h2>\n<h3>C</h3>\n<h4>D</h4>\n<h4>E</h4>\n",
  );
  expect(html("- a\n- b")).toBe("<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n");
  expect(html("3. c\n4. d")).toBe('<ol start="3">\n<li>c</li>\n<li>d</li>\n</ol>\n');
  expect(html("~~old~~ **b** *e* `c`\n\n> q\n\n---")).toBe(
    "<p><s>old</s> <strong>b</strong> <em>e</em> <code>c</code></p>\n<blockquote>\n<p>q</p>\n</blockquote>\n<hr>\n",
  );
  expect(html("| a | b |\n| :-: | --: |\n| 1 | 2 |")).toContain(
    '<th style="text-align:center">a</th>',
  );
  // A table may follow a paragraph line directly.
  expect(html("Owners:\n| a |\n|---|\n| b |")).toMatch(/^<p>Owners:<\/p>\n<table>/);
});

test("a fence shows its info string above its code, and code is escaped", () => {
  expect(html("```ts ignore previous\n<b>x</b>\n```")).toBe(
    '<pre class="fence"><span class="fence-info">ts ignore previous</span><code>&lt;b&gt;x&lt;/b&gt;\n</code></pre>\n',
  );
  expect(html("    indented")).toBe('<pre class="fence"><code>indented\n</code></pre>\n');
});

test("controls that reorder or hide text show as markers, raw or as entities", () => {
  expect(html("Pay &#x202E;4321&#x202C; now &#xE0049; end")).toBe(
    "<p>Pay ⟨U+202E⟩4321⟨U+202C⟩ now ⟨U+E0049⟩ end</p>\n",
  );
  expect(html("`a‮b`")).toBe("<p><code>a⟨U+202E⟩b</code></p>\n");
  expect(html('[a](https://y.test "x‮y")')).toContain('title="x⟨U+202E⟩y"');
  expect(html("[[ref‮|label]]")).toContain('title="ref⟨U+202E⟩ — not found"');
});

test("the tables of one body share the cell budget, and a table past it stays text", () => {
  const table = (columns: number, rows: number) =>
    [`|${" a |".repeat(columns)}`, `|${" - |".repeat(columns)}`]
      .concat(Array.from({ length: rows - 1 }, () => `|${" 1 |".repeat(columns)}`))
      .join("\n");

  // markdown-it fills in the cells a short row leaves out, and they count.
  expect(cells("| a | b | c |\n| - | - | - |\n| 1 |")).toBe(6);
  expect(cells(table(50, 100))).toBe(MAXIMUM_TABLE_CELLS);
  const past = html(`${table(2, 2)}\n\n${table(50, 101)}\n\n${table(2, 2)}`) ?? "";
  expect(past.match(/<table>/g)).toHaveLength(1);
});

test("a body cannot parse to more table cells than the budget, however few its characters", () => {
  // Each table fills in about 66,000 cells from 1,260 characters.
  const filling = `|${"|".repeat(209)}\n|${"-|".repeat(209)}\n${"a\n".repeat(315)}\n`;
  const started = performance.now();
  const tokens = parseMemoryMarkdown(filling.repeat(25)) ?? [];

  expect(tokens.filter((token) => token.type === "td_open").length).toBe(0);
  expect(tokens.length).toBeLessThan(1_000);
  expect(performance.now() - started).toBeLessThan(500);
});

test("a body that nests past the bound renders as text rather than losing its end", () => {
  const quoted = (depth: number) => `${">".repeat(depth)} deep`;
  expect(html(quoted(MAXIMUM_MARKDOWN_NESTING - 1))).toContain("deep");
  expect(html(quoted(MAXIMUM_MARKDOWN_NESTING))).toBeNull();
  // Each list level costs two, so an outline 40 levels deep still renders.
  const outline = (depth: number) =>
    Array.from({ length: depth }, (_, level) => `${"  ".repeat(level)}- item ${level}`).join("\n");
  expect(html(outline(40))).not.toBeNull();
  expect(html(outline(60))).toBeNull();
  // Emphasis pairs after markdown-it's bound applies, so inline depth is checked too.
  expect(html(`${"*a _a ".repeat(2_500)}x${" a_ a*".repeat(2_500)}`)).toBeNull();
});

test("parsing and rendering cost linear time on hostile bodies", () => {
  for (const input of [
    "> ".repeat(16_000),
    "*a".repeat(16_000),
    "[[".repeat(16_000),
    "[[a".repeat(10_000),
    `${"![".repeat(2_000)}a${"](https://x)".repeat(2_000)}`,
    `${"[".repeat(8_000)}a${"](https://x)".repeat(2_000)}`,
    `|${"a|".repeat(3_000)}\n|${"-|".repeat(3_000)}\n${"a\n".repeat(10_000)}`,
  ]) {
    const started = performance.now();
    html(input.slice(0, 32_000));
    expect(performance.now() - started).toBeLessThan(500);
  }
});

test("a modified, secondary, or handled click stays the browser's", () => {
  const click = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };

  expect(keepsBrowserClick(click)).toBe(false);
  for (const change of [
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
    { defaultPrevented: true },
  ]) {
    expect(keepsBrowserClick({ ...click, ...change })).toBe(true);
  }
});
