import { expect, test } from "vitest";
import { esc, plain, renderMarkdown } from "../src/lib/markdown.js";

const TARGET_MEMORY_ID = "e6f22a12-8b29-57ef-bbdf-ce11121303c7";

test("esc neutralizes raw HTML", () => {
  expect(esc("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
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
