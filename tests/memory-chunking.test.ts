import { expect, test } from "vitest";
import { chunkMemoryContent } from "@/lib/memory-chunking";

test("numbered facts become independent semantic chunks", () => {
  expect(
    chunkMemoryContent(
      "Here is a list of facts:\n0. Ada founded Acme.\n1. Grace acquired Acme.\n2. Lin leads Acme.",
    ),
  ).toEqual([
    "Here is a list of facts: 0. Ada founded Acme.",
    "1. Grace acquired Acme.",
    "2. Lin leads Acme.",
  ]);
});

test("Markdown list continuations stay with their item", () => {
  expect(chunkMemoryContent("- Alpha\n  continued detail\n- Beta")).toEqual([
    "- Alpha continued detail",
    "- Beta",
  ]);
});

test("ordinary prose keeps the existing length-bounded behavior", () => {
  expect(chunkMemoryContent("first paragraph\nsecond paragraph", 20)).toEqual([
    "first paragraph",
    "second paragraph",
  ]);
});

test("oversized list items remain length bounded", () => {
  const chunks = chunkMemoryContent(`- ${"a".repeat(12)}\n- short`, 5);
  expect(chunks).toEqual(["-", "aaaaa", "aaaaa", "aa", "-", "short"]);
  expect(chunks.every((chunk) => chunk.length <= 5)).toBe(true);
});

test("very large lists fall back to bounded chunks instead of creating unbounded rows", () => {
  const content = Array.from({ length: 257 }, (_, index) => `${index}. value`).join("\n");
  const chunks = chunkMemoryContent(content, 1_200);
  expect(chunks.length).toBeLessThan(257);
  expect(chunks.every((chunk) => chunk.length <= 1_200)).toBe(true);
});
