import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  chunkMemoryContent,
  createMemoryModule,
  createMemoryMutationPrimitives,
  type MemoryEmbeddingJobMessage,
  type MemoryStorageContext,
  MemoryVersionConflictError,
} from "../src/index";
import { createDeterministicTestEmbeddingProvider, testDatabase } from "../src/testing";

/**
 * The minimal host plus the two maintenance objects a write touches when an
 * embedding provider is configured: the job table and the generation lookup.
 */
const MAINTENANCE_WRITE_OBJECTS = `
CREATE TABLE memory_embedding_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  memory_scope memory_scope NOT NULL,
  memory_version integer NOT NULL,
  embedding_provider text NOT NULL,
  embedding_model text NOT NULL,
  embedding_revision text NOT NULL,
  generation_id uuid NOT NULL REFERENCES embedding_generations(id),
  UNIQUE (workspace_id, memory_id, memory_version, embedding_provider, embedding_model, embedding_revision)
);
CREATE FUNCTION lore.ensure_embedding_generation(
  target_provider text, target_model text, target_dimensions integer, target_revision text
) RETURNS TABLE(id uuid, status text) LANGUAGE sql AS $$
  INSERT INTO embedding_generations (
    id, embedding_provider, embedding_model, embedding_revision, embedding_dimensions, status
  )
  SELECT gen_random_uuid(), target_provider, target_model, target_revision, target_dimensions, 'active'
  WHERE NOT EXISTS (
    SELECT 1 FROM embedding_generations
    WHERE embedding_provider = target_provider AND embedding_model = target_model
      AND embedding_revision = target_revision
  );
  SELECT id, status FROM embedding_generations
  WHERE embedding_provider = target_provider AND embedding_model = target_model
    AND embedding_revision = target_revision;
$$;
`;

const partitionId = "20000000-0000-4000-8000-000000000001";
const ownerId = "10000000-0000-4000-8000-000000000001";

/** Three paragraphs long enough that chunking v2 keeps each in its own chunk. */
function paragraphs(...texts: string[]): string {
  return texts
    .map((text) => `${text} `.repeat(Math.ceil(900 / (text.length + 1))).trim())
    .join("\n\n");
}

interface ChunkRow {
  id: string;
  ordinal: number;
  content: string;
}

let postgres: PGlite;
let notified: MemoryEmbeddingJobMessage[];
let statements: string[];
let memories: ReturnType<typeof createMemoryModule>;
let storage: MemoryStorageContext;

beforeEach(async () => {
  postgres = new PGlite({ extensions: { vector } });
  await postgres.exec(
    await readFile(new URL("fixtures/independent-host-schema.sql", import.meta.url), "utf8"),
  );
  await postgres.exec(MAINTENANCE_WRITE_OBJECTS);
  notified = [];
  statements = [];
  storage = {
    database: testDatabase(
      postgres,
      () => undefined,
      (sql) => statements.push(sql),
    ),
    partitionId,
    ownerId,
  };
  memories = createMemoryModule(storage, {
    embeddingDimensions: 8,
    embeddingProvider: createDeterministicTestEmbeddingProvider(8),
    maintenanceNotifier: { notify: (message) => notified.push(message) },
  });
});

afterEach(async () => {
  await postgres.close();
});

async function chunksOf(memoryId: string): Promise<ChunkRow[]> {
  const result = await postgres.query<ChunkRow>(
    "SELECT id, ordinal, content FROM memory_chunks WHERE memory_id = $1 ORDER BY ordinal",
    [memoryId],
  );
  return result.rows;
}

async function jobsOf(
  memoryId: string,
): Promise<Array<{ memory_version: number; memory_scope: string }>> {
  const result = await postgres.query<{ memory_version: number; memory_scope: string }>(
    `SELECT memory_version, memory_scope FROM memory_embedding_jobs
     WHERE memory_id = $1 ORDER BY memory_version`,
    [memoryId],
  );
  return result.rows;
}

/** Give every current chunk a vector in the serving generation, as maintenance would. */
async function embedEveryChunk(memoryId: string): Promise<void> {
  await postgres.query(
    `INSERT INTO memory_chunk_embeddings (generation_id, chunk_id, workspace_id, memory_id, embedding)
     SELECT generation.id, chunk.id, chunk.workspace_id, chunk.memory_id, '[1,0,0,0,0,0,0,0]'
     FROM memory_chunks chunk, embedding_generations generation
     WHERE chunk.memory_id = $1
     ON CONFLICT DO NOTHING`,
    [memoryId],
  );
}

async function vectorChunkIds(memoryId: string): Promise<string[]> {
  const result = await postgres.query<{ chunk_id: string }>(
    "SELECT chunk_id FROM memory_chunk_embeddings WHERE memory_id = $1 ORDER BY chunk_id",
    [memoryId],
  );
  return result.rows.map((row) => row.chunk_id);
}

describe("update writes only what differs", () => {
  test("an update equal to the locked row writes nothing and keeps version and updatedAt", async () => {
    const created = await memories.remember({
      content: "Harbor observatory opens at dawn.",
      metadata: { category: "astronomy", tags: ["sky", "harbor"] },
    });
    const chunks = await chunksOf(created.id);
    notified = [];
    statements = [];

    const same = await memories.update(
      created.id,
      {
        content: created.content,
        scope: created.scope,
        // Key order is not identity: jsonb compares the value.
        metadata: { tags: ["sky", "harbor"], category: "astronomy" },
      },
      { expectedVersion: created.version },
    );

    expect(same).toEqual(created);
    expect(statements.some((sql) => /^\s*(UPDATE|DELETE|INSERT)\b/i.test(sql))).toBe(false);
    expect(await chunksOf(created.id)).toEqual(chunks);
    expect(await jobsOf(created.id)).toEqual([{ memory_version: 1, memory_scope: "shared" }]);
    expect(notified).toEqual([]);
  });

  test("a stale expected version is a conflict even when nothing would change", async () => {
    const created = await memories.remember({ content: "The tide table is printed weekly." });
    await expect(
      memories.update(created.id, { content: created.content }, { expectedVersion: 7 }),
    ).rejects.toBeInstanceOf(MemoryVersionConflictError);
    await expect(memories.update(created.id, {}, { expectedVersion: 7 })).resolves.toEqual(created);
  });

  test("an empty update returns the current row", async () => {
    const created = await memories.remember({ content: "Moorings are inspected in spring." });
    statements = [];
    await expect(memories.update(created.id, {})).resolves.toEqual(created);
    expect(statements.some((sql) => /FOR UPDATE/.test(sql))).toBe(false);
  });

  test("a metadata-only change keeps chunks and vectors and queues no job when all are embedded", async () => {
    const created = await memories.remember({
      content: "The lighthouse lamp is serviced monthly.",
    });
    await embedEveryChunk(created.id);
    const chunks = await chunksOf(created.id);
    const vectors = await vectorChunkIds(created.id);
    notified = [];

    const updated = await memories.update(
      created.id,
      { metadata: { category: "maintenance" } },
      { expectedVersion: 1 },
    );

    expect(updated).toMatchObject({ version: 2, metadata: { category: "maintenance" } });
    expect(await chunksOf(created.id)).toEqual(chunks);
    expect(await vectorChunkIds(created.id)).toEqual(vectors);
    expect(await jobsOf(created.id)).toEqual([{ memory_version: 1, memory_scope: "shared" }]);
    expect(notified).toEqual([]);
  });

  test("a scope-only change keeps chunks and vectors", async () => {
    const created = await memories.remember({ content: "Night watch rotates every four hours." });
    await embedEveryChunk(created.id);
    const chunks = await chunksOf(created.id);
    const vectors = await vectorChunkIds(created.id);
    notified = [];

    const updated = await memories.update(created.id, { scope: "private" }, { expectedVersion: 1 });

    expect(updated).toMatchObject({ version: 2, scope: "private", content: created.content });
    expect(await chunksOf(created.id)).toEqual(chunks);
    expect(await vectorChunkIds(created.id)).toEqual(vectors);
    expect(await jobsOf(created.id)).toEqual([{ memory_version: 1, memory_scope: "shared" }]);
    expect(notified).toEqual([]);
  });

  test("a scope change behind a still-pending job queues a job for the new version", async () => {
    const created = await memories.remember({ content: "Buoys are repainted before winter." });
    // The version-1 job never ran, so every chunk still lacks a vector; claiming it
    // would cancel it, because its version and scope no longer match the Memory.
    notified = [];

    await memories.update(created.id, { scope: "private" }, { expectedVersion: 1 });

    expect(await jobsOf(created.id)).toEqual([
      { memory_version: 1, memory_scope: "shared" },
      { memory_version: 2, memory_scope: "private" },
    ]);
    expect(notified).toHaveLength(1);
  });

  test("a content change replaces only the chunks whose ordinals differ", async () => {
    const original = paragraphs("Alpha harbor log.", "Bravo tide notes.", "Charlie crew roster.");
    const created = await memories.remember({ content: original });
    const before = await chunksOf(created.id);
    expect(before.map((chunk) => chunk.content)).toEqual(chunkMemoryContent(original));
    expect(before.length).toBe(3);
    await embedEveryChunk(created.id);
    notified = [];

    // The middle paragraph changes; the first and last stay byte-identical.
    const edited = paragraphs("Alpha harbor log.", "Bravo tide tables.", "Charlie crew roster.");
    const updated = await memories.update(created.id, { content: edited }, { expectedVersion: 1 });

    expect(updated).toMatchObject({ version: 2, content: edited });
    const after = await chunksOf(created.id);
    expect(after.map((chunk) => chunk.content).join("")).toBe(edited);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[1]?.id).not.toBe(before[1]?.id);
    expect(after[2]?.id).toBe(before[2]?.id);
    const vectors = await vectorChunkIds(created.id);
    expect(vectors).toEqual([before[0]?.id, before[2]?.id].sort());
    // The replaced chunk lacks a vector, so the new version is queued.
    expect(await jobsOf(created.id)).toEqual([
      { memory_version: 1, memory_scope: "shared" },
      { memory_version: 2, memory_scope: "shared" },
    ]);
    expect(notified).toHaveLength(1);
  });

  test("a shortened body deletes the stored tail and keeps the prefix", async () => {
    const original = paragraphs("Alpha harbor log.", "Bravo tide notes.", "Charlie crew roster.");
    const created = await memories.remember({ content: original });
    const before = await chunksOf(created.id);
    await embedEveryChunk(created.id);
    notified = [];

    const shortened = chunkMemoryContent(original).slice(0, 2).join("");
    expect(chunkMemoryContent(shortened)).toEqual(before.slice(0, 2).map((chunk) => chunk.content));
    await memories.update(created.id, { content: shortened }, { expectedVersion: 1 });

    const after = await chunksOf(created.id);
    expect(after.map((chunk) => chunk.id)).toEqual(before.slice(0, 2).map((chunk) => chunk.id));
    expect(await vectorChunkIds(created.id)).toEqual(
      before
        .slice(0, 2)
        .map((chunk) => chunk.id)
        .sort(),
    );
    // Every remaining chunk already has a vector, so no job is queued.
    expect(await jobsOf(created.id)).toEqual([{ memory_version: 1, memory_scope: "shared" }]);
    expect(notified).toEqual([]);
  });

  test("an appended paragraph inserts only the new tail", async () => {
    // A paragraph break belongs to the chunk before it, so a body that already ends
    // with one keeps its last chunk when a paragraph is appended.
    const original = `${paragraphs("Alpha harbor log.", "Bravo tide notes.")}\n\n`;
    const created = await memories.remember({ content: original });
    const before = await chunksOf(created.id);
    const extended = `${original}${paragraphs("Delta pier plan.")}`;
    expect(chunkMemoryContent(extended).slice(0, 2)).toEqual(before.map((chunk) => chunk.content));
    statements = [];

    await memories.update(created.id, { content: extended }, { expectedVersion: 1 });

    const after = await chunksOf(created.id);
    expect(after.slice(0, 2).map((chunk) => chunk.id)).toEqual(before.map((chunk) => chunk.id));
    expect(after).toHaveLength(3);
    expect(statements.some((sql) => /DELETE FROM memory_chunks/.test(sql))).toBe(false);
  });

  test("a chunk stored under an older chunking revision is replaced even when its text matches", async () => {
    const created = await memories.remember({ content: "Anchor chains are measured yearly." });
    const [before] = await chunksOf(created.id);
    await postgres.query(
      "UPDATE memory_chunks SET chunking_revision = 'old' WHERE memory_id = $1",
      [created.id],
    );

    await memories.update(
      created.id,
      { content: "Anchor chains are measured twice a year." },
      { expectedVersion: 1 },
    );

    const after = await chunksOf(created.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).not.toBe(before?.id);
    const revisions = await postgres.query<{ chunking_revision: string }>(
      "SELECT DISTINCT chunking_revision FROM memory_chunks WHERE memory_id = $1",
      [created.id],
    );
    expect(revisions.rows.map((row) => row.chunking_revision)).not.toContain("old");
  });

  test("versionUnchanged records the next version without touching chunks", async () => {
    const created = await memories.remember({ content: "Harbor fees are reviewed each May." });
    await embedEveryChunk(created.id);
    const chunks = await chunksOf(created.id);
    notified = [];
    const primitives = createMemoryMutationPrimitives({
      embeddingProvider: createDeterministicTestEmbeddingProvider(8),
      maintenanceNotifier: { notify: (message) => notified.push(message) },
    });

    const result = await storage.database.transaction((transaction) =>
      primitives.updateMemoryInTransaction(
        transaction,
        storage,
        created.id,
        { content: created.content },
        created.version,
        { commit: true, versionUnchanged: true },
      ),
    );

    expect(result).toMatchObject({ changed: false, chunksChanged: false, memory: { version: 2 } });
    expect(await chunksOf(created.id)).toEqual(chunks);
    expect(await jobsOf(created.id)).toEqual([{ memory_version: 1, memory_scope: "shared" }]);
    expect(notified).toEqual([]);
  });
});
