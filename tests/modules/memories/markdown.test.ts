import MarkdownIt from "markdown-it";
import { afterEach, expect, test, vi } from "vitest";
import {
  allowedHref,
  keepsBrowserClick,
  MAXIMUM_MARKDOWN_NESTING,
  MAXIMUM_TABLE_CELLS,
  parseMemoryMarkdown,
  renderMemoryMarkdown,
} from "@/modules/memories/browser/markdown";
import { plainInline } from "@/modules/memories/browser/presentation";

afterEach(() => {
  vi.restoreAllMocks();
});

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

/** A table of `columns` columns and `rows` rows, its header row included. */
function table(columns: number, rows: number): string {
  return [`|${" a |".repeat(columns)}`, `|${" - |".repeat(columns)}`]
    .concat(Array.from({ length: rows - 1 }, () => `|${" 1 |".repeat(columns)}`))
    .join("\n");
}

/** What `run` returns, and the table cells markdown-it built, kept or dropped, meanwhile. */
function withCellsParsed<T>(run: () => T): [T, number] {
  // Every markdown-it instance shares one block state class, so this sees the body's.
  const push = vi.spyOn(new MarkdownIt().block.State.prototype, "push");
  const result = run();
  const parsed = push.mock.calls.filter(([type]) => type === "td_open" || type === "th_open");
  push.mockRestore();
  return [result, parsed.length];
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
  const unresolved = 'class="wl-unresolved"';
  expect(html("[[topic/specs]]", { "topic/specs": TARGET_MEMORY_ID })).toContain(
    `data-memory-id="${TARGET_MEMORY_ID}"`,
  );
  // An inherited string is no target either, even one a prototype was given.
  expect(html("[[inherited]]", Object.create({ inherited: TARGET_MEMORY_ID }))).toContain(
    unresolved,
  );
  expect(html("[[empty]]", { empty: "" })).toContain(unresolved);
  const malformed = { count: 42 } as unknown as Record<string, string>;
  expect(html("[[count]]", malformed)).toContain(unresolved);
  // A reference named like an object property is no target unless the map holds it.
  const inherited = html("[[constructor]] [[__proto__]] [[toString]]") ?? "";
  expect(inherited.match(/class="wl-unresolved"/g)).toHaveLength(3);
  expect(inherited).not.toContain("<a ");
  // A map that holds the name itself resolves it like any other reference.
  const owned = Object.create(null) as Record<string, string>;
  Object.defineProperty(owned, "constructor", { value: TARGET_MEMORY_ID, enumerable: true });
  expect(html("[[constructor]]", owned)).toContain(
    `data-memory-id="${TARGET_MEMORY_ID}">constructor</a>`,
  );
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
    "https://user@example.test/",
    "https://example.test%5C@evil.test/",
    "https://example.com%2Eevil.com/",
    "https://good.com%E3%80%82evil.com/",
    "mailto:",
    "/memories",
    "",
  ]) {
    expect(allowedHref(url)).toBe(false);
  }
  for (const url of [
    "https://example.test/a@b",
    "https://example.test?to=a@b",
    "https://[::1]:8080/",
    "https://good.com/%2e",
  ]) {
    expect(allowedHref(url)).toBe(true);
  }
  // Userinfo can make an autolink's text name a host its target is not.
  expect(html("<https://example.com\\@evil.com>")).not.toContain("<a ");
  expect(html("[x](https://user@example.test)")).not.toContain("<a ");
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
  // Alt text keeps a wikilink's label and a strike's markers, as the body does.
  expect(html("![see [[ops/ch]] x](https://x.test/p.png)")).toContain(">see ops/ch x</a>");
  expect(html("![old ~~price~~ new](https://x.test/p.png)")).toContain(">old ~~price~~ new</a>");
});

test("an image's alt text and a link's title and target are escaped wherever they reach the page", () => {
  // As a link to its source, as words where its source is not allowed, and inside a link.
  expect(html("![<img src=x onerror=alert(1)>](https://x.test/a.png)")).toBe(
    `<p><a class="ext" href="https://x.test/a.png" ${EXTERNAL}>&lt;img src=x onerror=alert(1)&gt;</a></p>\n`,
  );
  expect(html("![<b>x</b>]()")).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>\n");
  expect(html("[![<b>x</b>](https://x.test/a.png)](https://d.test)")).toBe(
    `<p><a class="ext" href="https://d.test" ${EXTERNAL}>&lt;b&gt;x&lt;/b&gt;</a></p>\n`,
  );
  // A quote in a title cannot close the attribute, and a target's ampersand is escaped.
  expect(html(`[a](https://y.test 'x" onmouseover="alert(1)')`)).toContain(
    'title="x&quot; onmouseover=&quot;alert(1)"',
  );
  expect(html(`![a](https://y.test/p.png 'q" x="1')`)).toContain('title="q&quot; x=&quot;1"');
  expect(html("[a](https://y.test/?a=1&b=2)")).toContain('href="https://y.test/?a=1&amp;b=2"');
  // Alt text shows hidden controls as markers, as the rest of the body does.
  expect(html("![a\u202Eb](https://x.test/p.png)")).toContain(">a⟨U+202E⟩b</a>");
});

test("a wikilink in a link's text keeps the link from forming, so anchors never nest", () => {
  const rendered = html("[see [[ops/ch|CH]] now](https://y.test)", { "ops/ch": TARGET_MEMORY_ID });

  expect(rendered).toBe(
    `<p>[see <a class="wl" href="/memory/${TARGET_MEMORY_ID}" data-memory-id="${TARGET_MEMORY_ID}" title="ops/ch">CH</a> now](https://y.test)</p>\n`,
  );
  expect(rendered?.match(/<a /g)).toHaveLength(1);
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
  const payload = "<img src=x onerror=alert(1)>";
  expect(html(`\`${payload}\``)).toBe("<p><code>&lt;img src=x onerror=alert(1)&gt;</code></p>\n");
  expect(html(`\`\`\`${payload}\ncode\n\`\`\``)).toBe(
    '<pre class="fence"><span class="fence-info">&lt;img src=x onerror=alert(1)&gt;</span><code>code\n</code></pre>\n',
  );
});

test("controls that reorder or hide text show as markers, raw or as entities", () => {
  expect(html("Pay &#x202E;4321&#x202C; now &#xE0049; end")).toBe(
    "<p>Pay ⟨U+202E⟩4321⟨U+202C⟩ now ⟨U+E0049⟩ end</p>\n",
  );
  expect(html("`a\u202Eb`")).toBe("<p><code>a⟨U+202E⟩b</code></p>\n");
  expect(html('[a](https://y.test "x\u202Ey")')).toContain('title="x⟨U+202E⟩y"');
  expect(html("[[ref\u202E|label]]")).toContain('title="ref⟨U+202E⟩ — not found"');
  expect(html("```ts\u202E\nif (admin) {\u202E } else {\u2066\n```")).toBe(
    '<pre class="fence"><span class="fence-info">ts⟨U+202E⟩</span><code>if (admin) {⟨U+202E⟩ } else {⟨U+2066⟩\n</code></pre>\n',
  );
  expect(html("[[ref|a\u202Eb]]")).toContain(">a⟨U+202E⟩b</span>");
  expect(html("![a\u202Eb]()")).toBe("<p>a⟨U+202E⟩b</p>\n");
  expect(html("[![c\u202Ed](https://x.test/i.png)](https://d.test)")).toContain(">c⟨U+202E⟩d</a>");
});

test("the tables of one body share the cell budget, and the one past it keeps its words", () => {
  // markdown-it fills in the cells a short row leaves out, and they count.
  expect(cells("| a | b | c |\n| - | - | - |\n| 1 |")).toBe(6);
  // Four cells, then exactly the budget: each fits alone, but not together, and every
  // later table stays text too.
  const shared = html(`${table(2, 2)}\n\n${table(50, 100)}\n\n${table(2, 2)}`) ?? "";
  expect(shared.match(/<table>/g)).toHaveLength(1);
  // The table past the budget reads as its own lines of text, none of them lost.
  expect(shared).toContain(`<p>|${" a |".repeat(50)}<br>\n|${" - |".repeat(50)}<br>`);
  expect(shared.match(/\| 1 \|/g)?.length).toBeGreaterThanOrEqual(99);
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

test("images nested inside image labels count toward the nesting bound", () => {
  const nested = (depth: number) => `${"![".repeat(depth)}a${"](https://x.test)".repeat(depth)}`;

  // Each image label parses on its own, so only the renderer's count sees the depth.
  expect(html(nested(MAXIMUM_MARKDOWN_NESTING - 1))).toBe(
    `<p><a class="ext" href="https://x.test" ${EXTERNAL}>a</a></p>\n`,
  );
  expect(html(nested(MAXIMUM_MARKDOWN_NESTING))).toBeNull();
});

test("parsing and rendering cost linear time on hostile bodies", () => {
  // Four times the 32,000-character body bound, so a quadratic cost cannot fit the budget.
  for (const input of [
    "> ".repeat(64_000),
    "*a".repeat(64_000),
    "[[".repeat(64_000),
    "[[a".repeat(40_000),
    `${"![".repeat(8_000)}a${"](https://x)".repeat(8_000)}`,
    `${"[".repeat(32_000)}a${"](https://x)".repeat(8_000)}`,
  ]) {
    const started = performance.now();
    html(input);
    // Linear time stays well under this on a busy machine; a quadratic cost takes seconds.
    expect(performance.now() - started).toBeLessThan(1_500);
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

test("a resolved wikilink escapes its target id, and an unresolved one its reason", () => {
  const id = '"><img src=x onerror=alert(1)>';
  const rendered = html("[[r]]", { r: id }) ?? "";
  expect(rendered).not.toContain("<img");
  expect(rendered).toContain('href="/memory/%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E"');
  expect(rendered).toContain('data-memory-id="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  const tokens = parseMemoryMarkdown("[[m]]") ?? [];
  expect(renderMemoryMarkdown(tokens, {}, '"><b>x</b>')).toContain(
    'title="m — &quot;&gt;&lt;b&gt;x&lt;/b&gt;"',
  );
});

test("bold, emphasis, and strikethrough close after CJK punctuation, and English reads as before", () => {
  expect(html("**注意：**请先阅读")).toBe("<p><strong>注意：</strong>请先阅读</p>\n");
  expect(html("**「重要」**这是说明")).toBe("<p><strong>「重要」</strong>这是说明</p>\n");
  expect(html("*斜体。*后文 ~~删除。~~后文")).toBe(
    "<p><em>斜体。</em>后文 <s>删除。</s>后文</p>\n",
  );
  expect(html("**English:**text and 2 * 3 * 4")).toBe("<p>**English:**text and 2 * 3 * 4</p>\n");
});

test("a link with no words of its own shows its target", () => {
  expect(html("[](https://y.test) and [ ](https://z.test)")).toBe(
    `<p><a class="ext" href="https://y.test" ${EXTERNAL}>https://y.test</a> and <a class="ext" href="https://z.test" ${EXTERNAL}>https://z.test </a></p>\n`,
  );
  // An image with no alt text, or zero-width words, are no words either. Words are
  // what an image's alt shows, not its source: markup around nothing is none.
  for (const label of [
    "![](https://x.test/l.png)",
    "![\u200B](https://x.test/l.png)",
    "![**\u200B**](https://x.test/l.png)",
    "\u200B\u2060",
  ]) {
    expect(html(`[${label}](https://d.test)`)).toContain(`${EXTERNAL}>https://d.test`);
  }
  for (const alt of ["\u200B", " "]) {
    expect(html(`![${alt}](https://x.test/a.png)`)).toContain(">https://x.test/a.png</a>");
  }
});

test("a link whose host is written outside ASCII stays text", () => {
  // Such a host goes where its punycode points, which can read as another host.
  for (const markdown of [
    "<https://github.com\u2215corespeed-io\u2215lore.attacker.dev>",
    "<https://paypal.com\u3002evil.com>",
    "[docs](https://\u4F8B\u3048.jp)",
    // A mailto host is punycoded too, whatever case its scheme is written in.
    "<mailto:security@github.com\u2215x.evil.dev>",
    "<MAILTO:security@github.com\u2215x.evil.dev>",
    "<mailto:security@g\u0131thub.com>",
    // markdown-it trims Unicode whitespace before it reads the host, and so does the check.
    "[docs](\uFEFFhttps://\u4F8B\u3048.jp)",
    "[docs](< https://\u4F8B\u3048.jp>)",
    "![](\u00A0https://paypal.com\u3002evil.com)",
    "[a](\u00A0mailto:x@\u00FC.com)",
  ]) {
    expect(html(markdown), markdown).not.toContain("<a ");
  }
  // A path outside ASCII is fine, and a scheme in capitals still links.
  expect(html("<https://example.test/caf\u00E9>")).toContain("<a ");
  expect(html("<HTTPS://example.test>")).toContain("<a ");
  expect(html("<mailto:team@example.test>")).toContain('href="mailto:team@example.test"');
  // A host of `s` and `k` is ASCII: they only fold to ſ and K under a case-blind match.
  expect(html("<https://sk.test>")).toContain('href="https://sk.test"');
});

test("an autolink shows its URL as written, never decoded", () => {
  expect(html("<https://xn--pple-43d.com/a%EF%BC%8Fb>")).toContain(
    `${EXTERNAL}>https://xn--pple-43d.com/a%EF%BC%8Fb</a>`,
  );
  expect(plainInline("<https://xn--pple-43d.com>")).toBe("https://xn--pple-43d.com");
  expect(plainInline("<a@xn--pple-43d.com>")).toBe("a@xn--pple-43d.com");
});

test("an escaped closing bracket keeps a wikilink from forming, after a label too", () => {
  expect(html("[[a\\]]", { a: TARGET_MEMORY_ID })).toBe("<p>[[a]]</p>\n");
  expect(plainInline("[[a\\]]")).toBe("[[a]]");
  expect(plainInline("[[a|b\\]]")).toBe("[[a|b]]");
  // An escaped backslash leaves the brackets to close the wikilink.
  expect(html("[[a\\\\]]")).toContain('class="wl-unresolved"');
  // Before a label's pipe, an odd run escapes the pipe and loses one backslash; an even
  // run is the reference's own.
  expect(html("[[a\\|b]]")).toContain('title="a — not found">b</span>');
  expect(html("[[a\\\\|b]]")).toContain('title="a\\\\ — not found">b</span>');
  expect(html("[[a\\\\\\|b]]")).toContain('title="a\\\\ — not found">b</span>');
});

test("a label or reference of only hidden controls shows as its markers", () => {
  expect(html("[\u202E](https://d.test)")).toContain(`${EXTERNAL}>⟨U+202E⟩</a>`);
  expect(html("[[a|\u202E]]")).toContain('title="a — not found">⟨U+202E⟩</span>');
  expect(html("[[\u202E]]")).toContain('<span class="wl-unresolved"');
});

test("a wikilink whose label shows nothing reads as its reference, and one with no reference stays text", () => {
  const targets = { foo: TARGET_MEMORY_ID };
  expect(html("[[foo|\u200B]]", targets)).toContain(`data-memory-id="${TARGET_MEMORY_ID}">foo</a>`);
  expect(html("[[missing|\u2060]]")).toContain('title="missing — not found">missing</span>');
  expect(html("[[\u200B]]")).toBe("<p>[[\u200B]]</p>\n");
});

test("a title reads a link as its label exactly where the body renders one", () => {
  const read = (target: string) => {
    const markdown = `[label](${target})`;
    return {
      linked: html(markdown)?.includes(">label</a>") ?? false,
      reduced: plainInline(markdown) === "label",
    };
  };
  for (const target of [
    "https://example.test",
    "HTTPS://example.test",
    "MAILTO:team@example.test",
    "<https://example.test/a b>",
    "<mailto:team@example.test>",
    'https://example.test "Title"',
    "https://example.test 'Title'",
    "https://example.test (Title)",
    "https://example.test/(a)",
    "https://example.test/((a))",
  ]) {
    expect(read(target), target).toEqual({ linked: true, reduced: true });
  }
  for (const target of [
    "https:/path",
    "https:///path",
    "javascript:alert(1)",
    "https://?q",
    "http://?q",
    "mailto:",
    "<https://>",
    "https://\\/x",
    "https://&#47;x",
    "https://a\u0001b",
    '<https://x>\u00A0"t"',
  ]) {
    expect(read(target), target).toEqual({ linked: false, reduced: false });
  }
});

test("a title shows the words the body shows, whatever the label holds", () => {
  const targets = { "ops/ch": TARGET_MEMORY_ID };
  for (const [markdown, words] of [
    ["2**10 and *.ts or *.js", "2**10 and *.ts or *.js"],
    ["[see [[a]] x](https://x.test)", "[see a x](https://x.test)"],
    ["[\u200B](https://x.test)", "https://x.test\u200B"],
    ["![\u200B](https://x.test/a.png)", "https://x.test/a.png"],
    ["[[ops/ch|\u200B]] and [[ref\\|label]]", "ops/ch and label"],
    ["[[ ]] and [[\u200B]]", "[[ ]] and [[\u200B]]"],
    ["AT&amp;T `a&amp;b` ~~old~~ **new**", "AT&T a&amp;b ~~old~~ new"],
  ] as const) {
    expect(plainInline(markdown), markdown).toBe(words);
    // The body shows the same words, whether or not the wikilink resolves.
    const shown = (html(markdown, targets) ?? "")
      .replace(/<\/?s>/g, "~~")
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .trim();
    expect(shown, markdown).toBe(words);
  }
});

test("a table past the budget is parsed no further than one row past it", () => {
  // Without the stop, markdown-it would fill in 65,536 cells before the table is dropped.
  const wide = `|${"a|".repeat(4_000)}\n|${"-|".repeat(4_000)}\n${"a\n".repeat(4_000)}`;
  const long = `|${"a|".repeat(200)}\n|${"-|".repeat(200)}\n${"a\n".repeat(10_000)}`;
  // Each of these tables fills in about 66,000 cells from 1,260 characters.
  const filling = `|${"|".repeat(209)}\n|${"-|".repeat(209)}\n${"a\n".repeat(315)}\n`;
  for (const [input, columns] of [
    [wide, 4_000],
    [long, 200],
    [filling.repeat(25), 209],
  ] as const) {
    const [tokens, parsed] = withCellsParsed(() => parseMemoryMarkdown(input.slice(0, 32_000)));
    expect(parsed).toBeLessThanOrEqual(MAXIMUM_TABLE_CELLS + columns);
    expect((tokens ?? []).filter((token) => token.type === "td_open")).toHaveLength(0);
  }
});

test("once the budget is spent, a later table is not parsed at all", () => {
  const [rendered, parsed] = withCellsParsed(
    () => html(`${table(50, 100)}\n\n${table(2, 2)}`) ?? "",
  );
  // The first table spends the whole budget, and the second builds no cell.
  expect(parsed).toBe(MAXIMUM_TABLE_CELLS);
  expect(rendered.match(/<table>/g)).toHaveLength(1);
  expect(rendered).toContain("<p>| a | a |<br>");
});

test("an image's alt text reads a hard break as a space and emphasis as its words", () => {
  expect(html("![a\nb](https://x.test/p.png)")).toContain(">a b</a>");
  expect(html("![a  \nb](https://x.test/p.png)")).toContain(">a b</a>");
  expect(html("![a\\\nb](https://x.test/p.png)")).toContain(">a b</a>");
  expect(html("![**b** _i_ `c` x](https://x.test/p.png)")).toContain(">b i c x</a>");
  // Code is words of a link's own, so the link shows it rather than its target.
  expect(html("[`x`](https://d.test)")).toBe(
    `<p><a class="ext" href="https://d.test" ${EXTERNAL}><code>x</code></a></p>\n`,
  );
});

test("a table without outer pipes, in a quote, or in a list item counts its columns as the budget does", () => {
  const bare = (rows: number) =>
    [Array(50).fill("a").join(" | "), Array(50).fill("---").join(" | ")]
      .concat(Array.from({ length: rows - 1 }, () => Array(50).fill("1").join(" | ")))
      .join("\n");
  const quoted = (rows: number) =>
    table(50, rows)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  const listed = (rows: number) =>
    table(50, rows)
      .split("\n")
      .map((line, index) => `${index === 0 ? "-" : " "} ${line}`)
      .join("\n");
  for (const shape of [(rows: number) => table(50, rows), bare, quoted, listed]) {
    // A table of exactly the budget renders whole, never cut short a row early.
    expect(cells(shape(100))).toBe(MAXIMUM_TABLE_CELLS);
    expect(cells(shape(101))).toBe(0);
  }
});
