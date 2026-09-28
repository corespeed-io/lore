import { expect, test } from "vitest";
import { esc, plain, renderMarkdown } from "../../../src/modules/memories/browser/markdown.js";

const TARGET_MEMORY_ID = "e6f22a12-8b29-57ef-bbdf-ce11121303c7";

test("esc neutralizes raw HTML", () => {
  expect(esc("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
  expect(esc(42)).toBe("42");
});

test("renderMarkdown resolves wikilinks to native Memory ids", () => {
  const html = renderMarkdown("See [[topic/retrieval/specs|technical specs]]", {
    "topic/retrieval/specs": TARGET_MEMORY_ID,
  });

  expect(html).toContain(`data-memory-id="${TARGET_MEMORY_ID}"`);
  expect(html).toContain(`href="/memory/${TARGET_MEMORY_ID}"`);
  expect(html).toContain(">technical specs</a>");
  expect(html).not.toContain("[[topic/retrieval/specs");
});

test("renderMarkdown keeps unresolved wikilinks inert and XSS-safe", () => {
  const html = renderMarkdown("[[missing/<img src=x onerror=alert(1)>|Missing <script>]]", {});

  expect(html).toContain('class="wl-unresolved"');
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<a");
});

test("renderMarkdown lets the caller explain an unresolved wikilink", () => {
  const pending = renderMarkdown("[[topic/retrieval/specs]]", {}, 'Resolving "reference"…');

  expect(pending).toContain('class="wl-unresolved"');
  expect(pending).toContain('title="Resolving &quot;reference&quot;…"');
  expect(pending).not.toContain("not found");
  expect(pending).not.toContain("<a");
  expect(renderMarkdown("[[topic/retrieval/specs]]", {})).toContain(
    'title="Memory reference not found"',
  );
});

test("renderMarkdown never resolves inherited object properties as Memory ids", () => {
  expect(() => renderMarkdown("[[constructor]] [[__proto__]]", {})).not.toThrow();
  const html = renderMarkdown("[[constructor]] [[__proto__]]", {});

  expect(html.match(/class="wl-unresolved"/g)).toHaveLength(2);
  expect(html).not.toContain("<a");
});

test("renderMarkdown can safely resolve a reference named like an object property", () => {
  const targets = Object.create(null) as Record<string, string>;
  Object.defineProperty(targets, "constructor", {
    value: TARGET_MEMORY_ID,
    enumerable: true,
  });

  expect(renderMarkdown("[[constructor]]", targets)).toContain(
    `data-memory-id="${TARGET_MEMORY_ID}"`,
  );
});

test("plain uses wikilink labels", () => {
  expect(plain("# H\n**b** [[a/b|c]] `x`")).toBe("H b c x");
});

test("renderMarkdown keeps paragraphs and line breaks as written", () => {
  expect(renderMarkdown("First.\n\nSecond.")).toBe("<p>First.</p><p>Second.</p>");
  expect(renderMarkdown("Line one\nline two")).toBe("<p>Line one<br>line two</p>");
  expect(renderMarkdown("A\r\n\r\n\r\nB")).toBe("<p>A</p><p>B</p>");
});

test("renderMarkdown sets headings, lists, and fences apart from paragraphs", () => {
  expect(renderMarkdown("# Heading\nText")).toBe("<h3>Heading</h3><p>Text</p>");
  expect(renderMarkdown("Methods:\n- one\n  - nested\n      - deep\nAfter")).toBe(
    '<p>Methods:</p><span class="li">one</span><span class="li li-1">nested</span>' +
      '<span class="li li-3">deep</span><p>After</p>',
  );
  expect(renderMarkdown("Before\n```\nx < y\n```\nAfter")).toBe(
    '<p>Before</p><pre class="fence">\nx &lt; y\n</pre><p>After</p>',
  );
});

test("renderMarkdown keeps inline markup inside one line", () => {
  expect(renderMarkdown("**bold** and `code`")).toBe("<p><b>bold</b> and <code>code</code></p>");
  // A bold or code marker never pairs across a line break.
  expect(renderMarkdown("**open\nclose**")).toBe("<p>**open<br>close**</p>");
  expect(renderMarkdown("- *a* item")).toBe('<span class="li"><i>a</i> item</span>');
  expect(renderMarkdown("<script>alert(1)</script>\n\n- <img src=x>")).toBe(
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><span class="li">&lt;img src=x&gt;</span>',
  );
});
