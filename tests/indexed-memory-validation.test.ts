import { expect, test } from "vitest";
import { chunkMemoryContent } from "@/lib/memory-chunking";
import {
  type IndexedMemoryChunk,
  validateExactIndexedMemory,
} from "../scripts/lib/indexed-memory-validation";

const provider = { provider: "test", model: "embed", revision: "v1" };
const content = `${"alpha ".repeat(250)}omega`;

function activeChunks(value = content): IndexedMemoryChunk[] {
  return chunkMemoryContent(value).map((chunk, ordinal) => ({
    ordinal,
    content: chunk,
    embedded: true,
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

test("exact indexed-memory validation can verify an RLS tripwire without requiring vectors", () => {
  expect(() =>
    validateExactIndexedMemory({
      actualContent: content,
      chunks: activeChunks().map((chunk) => ({
        ...chunk,
        embedded: false,
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
