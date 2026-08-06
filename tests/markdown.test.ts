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

test("plain uses wikilink labels", () => {
  expect(plain("# H\n**b** [[a/b|c]] `x`")).toBe("H b c x");
});
