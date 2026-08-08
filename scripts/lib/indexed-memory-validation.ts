import type pg from "pg";
import type { EmbeddingProvider } from "../../src/lib/memory";
import { chunkMemoryContent } from "../../src/lib/memory-chunking";

export interface IndexedMemoryChunk {
  content: string;
  embedded: boolean;
  embedding_model: string | null;
  embedding_provider: string | null;
  embedding_revision: string | null;
  ordinal: number;
}

export function validateExactIndexedMemory(input: {
  actualContent: string;
  chunks: IndexedMemoryChunk[];
  expectedContent: string;
  embeddingProvider: Pick<EmbeddingProvider, "model" | "provider" | "revision">;
  label: string;
  requireEmbedding?: boolean;
}): void {
  if (input.actualContent !== input.expectedContent) {
    throw new Error(`Indexed ${input.label} content does not match the pinned source`);
  }
  const expectedChunks = chunkMemoryContent(input.expectedContent);
  if (input.chunks.length !== expectedChunks.length) {
    throw new Error(`Indexed ${input.label} has an incomplete chunk sequence`);
  }
  for (const [index, chunk] of input.chunks.entries()) {
    const invalidEmbedding =
      input.requireEmbedding !== false &&
      (!chunk.embedded ||
        chunk.embedding_provider !== input.embeddingProvider.provider ||
        chunk.embedding_model !== input.embeddingProvider.model ||
        chunk.embedding_revision !== input.embeddingProvider.revision);
    if (chunk.ordinal !== index || chunk.content !== expectedChunks[index] || invalidEmbedding) {
      throw new Error(`Indexed ${input.label} chunk ${index} failed exact validation`);
    }
  }
}

export async function requireExactIndexedMemory(input: {
  client: pg.Client;
  memoryId: string;
  expectedContent: string;
  embeddingProvider: EmbeddingProvider;
  label: string;
  requireEmbedding?: boolean;
}): Promise<void> {
  const memory = await input.client.query<{ content: string }>(
    "SELECT content FROM memories WHERE id = $1",
    [input.memoryId],
  );
  if (memory.rows.length !== 1) throw new Error(`Indexed ${input.label} is missing`);
  const chunks = await input.client.query<IndexedMemoryChunk>(
    `SELECT
       ordinal,
       content,
       embedding IS NOT NULL AS embedded,
       embedding_provider,
       embedding_model,
       embedding_revision
     FROM memory_chunks
     WHERE memory_id = $1
     ORDER BY ordinal`,
    [input.memoryId],
  );
  validateExactIndexedMemory({
    actualContent: memory.rows[0]?.content ?? "",
    chunks: chunks.rows,
    expectedContent: input.expectedContent,
    embeddingProvider: input.embeddingProvider,
    label: input.label,
    requireEmbedding: input.requireEmbedding,
  });
}
