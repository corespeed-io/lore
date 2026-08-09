import { expect, test } from "vitest";
import type { EmbeddingProvider } from "@/lib/memory";
import { chunkMemoryContent } from "@/lib/memory-chunking";
import {
  type IndexedMemoryChunk,
  requireExactIndexedMemory,
  validateExactIndexedMemory,
} from "../scripts/lib/indexed-memory-validation";

const provider: EmbeddingProvider = {
  provider: "test",
  model: "embed",
  dimensions: 1024,
  revision: "v1",
  async embed() {
    return [];
  },
};
const content = `${"alpha ".repeat(250)}omega`;

function activeChunks(value = content): IndexedMemoryChunk[] {
  return chunkMemoryContent(value).map((chunk, ordinal) => ({
    ordinal,
    content: chunk,
    embedded: true,
    embedding_dimensions: provider.dimensions,
    embedding_provider: provider.provider,
    embedding_model: provider.model,
    embedding_revision: provider.revision,
  }));
}

test("exact indexed-memory validation accepts the complete active chunk sequence", () => {
  expect(() =>
    validateExactIndexedMemory({
      actualContent: content,
      chunks: activeChunks(),
      expectedContent: content,
      embeddingProvider: provider,
      label: "fixture",
    }),
  ).not.toThrow();
});

test("exact indexed-memory lookup reads the active generation-scoped vector table", async () => {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      return queries.length === 1 ? { rows: [{ content }] } : { rows: activeChunks() };
    },
  };

  await requireExactIndexedMemory({
    client: client as never,
    memoryId: "00000000-0000-4000-8000-000000000001",
    expectedContent: content,
    embeddingProvider: provider,
    label: "fixture",
  });

  expect(queries[1]?.text).toContain("memory_chunk_embeddings");
  expect(queries[1]?.text).toContain("embedding_generations");
  expect(queries[1]?.text).not.toMatch(/chunk\.embedding\b/);
  expect(queries[1]?.values).toEqual([
    "00000000-0000-4000-8000-000000000001",
    provider.provider,
    provider.model,
    provider.dimensions,
    provider.revision,
  ]);
});

test("exact indexed-memory validation can verify an RLS tripwire without requiring vectors", () => {
  expect(() =>
    validateExactIndexedMemory({
      actualContent: content,
      chunks: activeChunks().map((chunk) => ({
        ...chunk,
        embedded: false,
        embedding_dimensions: null,
        embedding_provider: null,
        embedding_model: null,
        embedding_revision: null,
      })),
      expectedContent: content,
      embeddingProvider: provider,
      label: "private tripwire",
      requireEmbedding: false,
    }),
  ).not.toThrow();
});

test.each([
  ["deleted chunk", () => activeChunks().slice(0, -1)],
  [
    "mutated chunk",
    () => activeChunks().map((chunk, index) => (index ? chunk : { ...chunk, content: "changed" })),
  ],
  [
    "stale embedding",
    () =>
      activeChunks().map((chunk, index) =>
        index ? chunk : { ...chunk, embedding_revision: "stale" },
      ),
  ],
  [
    "wrong embedding dimensions",
    () =>
      activeChunks().map((chunk, index) =>
        index ? chunk : { ...chunk, embedding_dimensions: 1536 },
      ),
  ],
])("exact indexed-memory validation rejects a %s", (_label, chunks) => {
  expect(() =>
    validateExactIndexedMemory({
      actualContent: content,
      chunks: chunks(),
      expectedContent: content,
      embeddingProvider: provider,
      label: "fixture",
    }),
  ).toThrow(/chunk/);
});
