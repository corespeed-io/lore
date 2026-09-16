import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, test } from "vitest";
import {
  createMemoryModule,
  type MemoryStorageContext,
  MemoryVersionConflictError,
} from "../src/index";
import { testDatabase } from "../src/testing";

test("an independent storage host runs Memory CRUD and retrieval without OSS identity", async () => {
  const postgres = new PGlite({ extensions: { vector } });
  try {
    await postgres.exec(
      await readFile(new URL("fixtures/independent-host-schema.sql", import.meta.url), "utf8"),
    );
    const storage: MemoryStorageContext = {
      database: testDatabase(postgres),
      partitionId: "20000000-0000-4000-8000-000000000001",
      ownerId: "10000000-0000-4000-8000-000000000001",
      sourceId: "30000000-0000-4000-8000-000000000001",
    };
    const memories = createMemoryModule(storage, { embeddingDimensions: 8 });
    const content = `# Harbor observatory\n\n${"The observatory opens before sunrise. ".repeat(80)}`;
    const created = await memories.remember({ content, metadata: { category: "astronomy" } });

    expect(created).toMatchObject({
      partitionId: storage.partitionId,
      ownerId: storage.ownerId,
      sourceId: storage.sourceId,
      content,
      version: 1,
    });
    await expect(memories.retrieve(created.id)).resolves.toEqual(created);
    const found = await memories.search({ query: "harbor observatory" });
    expect(found.map((result) => result.memory.id)).toEqual([created.id]);
    const chunks = await postgres.query<{ content: string }>(
      "SELECT content FROM memory_chunks WHERE memory_id = $1 ORDER BY ordinal",
      [created.id],
    );
    expect(chunks.rows.length).toBeGreaterThan(1);
    expect(chunks.rows.map((row) => row.content).join("")).toBe(content);

    const updated = await memories.update(
      created.id,
      { content: "The coastal telescope now opens at midnight." },
      { expectedVersion: 1 },
    );
    expect(updated).toMatchObject({ id: created.id, version: 2 });
    await expect(
      memories.update(created.id, { content: "Stale replacement" }, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(MemoryVersionConflictError);
    await expect(memories.search({ query: "observatory" })).resolves.toEqual([]);
    expect((await memories.search({ query: "coastal telescope" }))[0]?.memory.id).toBe(created.id);
    await expect(
      memories.list({ metadataFilter: { category: "astronomy" } }),
    ).resolves.toMatchObject([{ id: created.id, version: 2, metadata: { category: "astronomy" } }]);

    const otherPartition = createMemoryModule(
      { ...storage, partitionId: "20000000-0000-4000-8000-000000000002" },
      { embeddingDimensions: 8 },
    );
    await expect(otherPartition.retrieve(created.id)).resolves.toBeNull();
    await expect(otherPartition.list()).resolves.toEqual([]);
    await expect(otherPartition.search({ query: "coastal telescope" })).resolves.toEqual([]);

    await expect(memories.forget(created.id, { expectedVersion: 2 })).resolves.toBe(true);
    await expect(memories.retrieve(created.id)).resolves.toBeNull();
    await expect(memories.list()).resolves.toEqual([]);
    await expect(memories.search({ query: "coastal telescope" })).resolves.toEqual([]);
    const remaining = await postgres.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM memory_chunks",
    );
    expect(remaining.rows[0]?.count).toBe(0);

    const identityTables = await postgres.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('users', 'workspaces', 'agents', 'memberships')`,
    );
    expect(identityTables.rows).toEqual([]);
    const permissionFunctions = await postgres.query<{ proname: string }>(
      `SELECT proname FROM pg_proc
       WHERE proname IN ('can_read_memory', 'can_write_memory')`,
    );
    expect(permissionFunctions.rows).toEqual([]);
  } finally {
    await postgres.close();
  }
});
