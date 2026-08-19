import { chunkMemoryContent } from "@corespeed/lore-core";
import { expect, test } from "vitest";

function expectValidPartition(content: string, chunks: readonly string[], maximumLength: number) {
  expect(chunks.join("")).toBe(content);
  expect(chunks.every((chunk) => chunk.trim().length > 0)).toBe(true);
  expect(chunks.every((chunk) => Array.from(chunk).length <= maximumLength)).toBe(true);
  expect(chunks.every((chunk) => !/[\uD800-\uDFFF]/u.test(Array.from(chunk).at(-1) ?? ""))).toBe(
    true,
  );
}

test("Memory chunking preserves exact Markdown and prefers section boundaries", () => {
  const first = "# Decision\nKeep the API stable.\n\n";
  const second = "# Rationale\nAvoid contract drift.";
  const content = first + second;

  const chunks = chunkMemoryContent(content, 36);

  expect(chunks).toEqual([first, second]);
  expectValidPartition(content, chunks, 36);
});

test("Memory chunking keeps bounded list items intact", () => {
  const items = [
    `- alpha ${"a".repeat(16)}\n`,
    `- beta ${"b".repeat(16)}\n`,
    `- gamma ${"c".repeat(16)}`,
  ];
  const content = items.join("");

  const chunks = chunkMemoryContent(content, 30);

  expect(chunks).toEqual(items);
  expectValidPartition(content, chunks, 30);
});

test("Memory chunking measures Unicode code points and never splits a surrogate pair", () => {
  const content = `${"a".repeat(11)}😀${"b".repeat(11)}`;

  const chunks = chunkMemoryContent(content, 12);

  expect(chunks).toEqual([`${"a".repeat(11)}😀`, "b".repeat(11)]);
  expectValidPartition(content, chunks, 12);
});

test("Memory chunking exactly reconstructs an adversarial formatted corpus", () => {
  const corpus = [
    "  leading and trailing whitespace  ",
    "第一段。第二段！\r\n\r\n第三段？",
    "family 👨‍👩‍👧‍👦 and decomposed cafe\u0301 remain exact",
    "```ts\nconst value = `a  b`;\n```\n\nAfter the fence.",
    "| key | value |\n| --- | --- |\n| a | b |",
  ];

  for (const content of corpus) {
    const first = chunkMemoryContent(content, 18);
    const second = chunkMemoryContent(content, 18);
    expect(first).toEqual(second);
    expectValidPartition(content, first, 18);
  }
});

test("Memory chunking rejects an unindexable whitespace-only partition", () => {
  expect(() => chunkMemoryContent(`a${" ".repeat(30)}b`, 10)).toThrow("whitespace-only chunk");
});

test("Memory chunking rejects invalid maximum lengths", () => {
  expect(() => chunkMemoryContent("content", 0)).toThrow("positive integer");
  expect(() => chunkMemoryContent("content", 1.5)).toThrow("positive integer");
});
