import { expect, test } from "vitest";
import { esc, plain, renderMarkdown } from "../src/lib/markdown.js";

test("esc neutralizes HTML", () => {
  expect(esc("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
});

test("renderMarkdown escapes raw HTML before formatting (no XSS)", () => {
  const html = renderMarkdown("<script>alert(1)</script> **bold**");
  expect(html).not.toContain("<script>");
  expect(html).toContain("<b>bold</b>");
});

test("renderMarkdown turns wikilinks into anchors with data-slug", () => {
  const html = renderMarkdown("see [[people/hao-su|Hao]]");
  expect(html).toContain('data-slug="people/hao-su"');
  expect(html).toContain(">Hao<");
});

test("plain strips markdown to text", () => {
  expect(plain("# H\n**b** [[a/b|c]] `x`")).toBe("H b c x");
});
