import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, test } from "vitest";
import {
  createMemoryGraphModule,
  createMemoryModule,
  createMemoryMutationPrimitives,
  insertMemoryLinksInTransaction,
  LoreValidationError,
  type MemoryStorageContext,
  MemoryVersionConflictError,
} from "../src/index";
import { missingSchemaContract, testDatabase } from "../src/testing";

test("an independent storage host runs Memory CRUD and retrieval without OSS identity", async () => {
  const postgres = new PGlite({ extensions: { vector } });
  try {
    await postgres.exec(
      await readFile(new URL("fixtures/independent-host-schema.sql", import.meta.url), "utf8"),
    );
    const database = testDatabase(postgres, () => undefined);
    const storage: MemoryStorageContext = {
      database,
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

test("the schema kit reads a host's tables through search_path, not public", async () => {
  const postgres = new PGlite({ extensions: { vector } });
  try {
    await postgres.exec("CREATE SCHEMA host; SET search_path TO host, public;");
    await postgres.exec(
      await readFile(new URL("fixtures/independent-host-schema.sql", import.meta.url), "utf8"),
    );
    await expect(missingSchemaContract(postgres, ["memory", "graph"])).resolves.toEqual([]);
    await postgres.exec("SET search_path TO public;");
    await expect(missingSchemaContract(postgres, ["memory"])).resolves.toEqual(
      expect.arrayContaining(["memory: table memories"]),
    );
  } finally {
    await postgres.close();
  }
});

test("the independent host provides the memory and graph contract groups", async () => {
  const postgres = new PGlite({ extensions: { vector } });
  try {
    await postgres.exec(
      await readFile(new URL("fixtures/independent-host-schema.sql", import.meta.url), "utf8"),
    );
    await expect(missingSchemaContract(postgres, ["memory", "graph"])).resolves.toEqual([]);
    // It deliberately omits the maintenance and Episode groups.
    await expect(missingSchemaContract(postgres, ["maintenance"])).resolves.not.toEqual([]);
  } finally {
    await postgres.close();
  }
});

test("an empty database lacks every table, type, function, and enum a group names", async () => {
  const postgres = new PGlite();
  try {
    const missing = await missingSchemaContract(postgres, ["memory", "graph"]);
    expect(missing).toEqual(
      expect.arrayContaining([
        "memory: table memories",
        "memory: table memory_chunks",
        "memory: type vector",
        "memory: function lore.extract_entity_aliases(text)",
        "memory: enum memory_scope (shared, private)",
        "graph: table memory_links",
      ]),
    );
    // A compared value is checked only against a column that exists.
    expect(missing.some((item) => item.includes("values "))).toBe(false);
  } finally {
    await postgres.close();
  }
});

test("a schema that drifts from the contract is reported item by item", async () => {
  const postgres = new PGlite({ extensions: { vector } });
  try {
    await postgres.exec(
      await readFile(new URL("fixtures/independent-host-schema.sql", import.meta.url), "utf8"),
    );
    const unique = await postgres.query<{ name: string }>(
      `SELECT conname AS name FROM pg_constraint
       WHERE conrelid = 'memory_links'::regclass AND contype = 'u'`,
    );
    await postgres.exec(`
      -- An engine-omitted NOT NULL column without a default.
      ALTER TABLE memories ALTER COLUMN version DROP DEFAULT;
      -- A lexical channel the host must derive, stored as a plain column.
      ALTER TABLE memory_chunks DROP COLUMN entity_aliases;
      ALTER TABLE memory_chunks ADD COLUMN entity_aliases text[];
      -- Forget deletes only the parent, so this foreign key must cascade.
      ALTER TABLE memory_chunks DROP CONSTRAINT memory_chunks_memory_id_fkey;
      ALTER TABLE memory_chunks ADD FOREIGN KEY (memory_id) REFERENCES memories(id);
      -- A generation status enum that cannot hold a value the engine compares.
      CREATE TYPE generation_status AS ENUM ('active', 'building');
      ALTER TABLE embedding_generations
        ALTER COLUMN status TYPE generation_status USING status::generation_status;
      -- A scope enum with a label the engine does not know.
      ALTER TYPE memory_scope ADD VALUE 'team';
      -- A missing column, and an ON CONFLICT target only a partial index covers.
      ALTER TABLE memory_links DROP COLUMN weight;
      ALTER TABLE memory_links DROP CONSTRAINT ${unique.rows[0]?.name};
      CREATE UNIQUE INDEX memory_links_partial ON memory_links
        (workspace_id, source_memory_id, target_memory_id, kind) WHERE kind <> '';
      -- An extra expression key cannot serve the four-column ON CONFLICT target either.
      CREATE UNIQUE INDEX memory_links_expression ON memory_links
        (workspace_id, source_memory_id, target_memory_id, kind, lower(kind));
    `);

    await expect(missingSchemaContract(postgres, ["memory", "graph"])).resolves.toEqual([
      "memory: default for memories.version, which the engine does not insert",
      "memory: generated column memory_chunks.entity_aliases",
      "memory: cascading foreign key memory_chunks.memory_id -> memories",
      "memory: enum memory_scope (shared, private)",
      "memory: values embedding_generations.status (active, retiring)",
      "graph: column memory_links.weight",
      "graph: unique key memory_links (workspace_id, source_memory_id, target_memory_id, kind)",
    ]);
  } finally {
    await postgres.close();
  }
});

test("Links, batch inserts, and forget run on the independent host", async () => {
  const postgres = new PGlite({ extensions: { vector } });
  try {
    await postgres.exec(
      await readFile(new URL("fixtures/independent-host-schema.sql", import.meta.url), "utf8"),
    );
    const database = testDatabase(postgres, () => undefined);
    const storage: MemoryStorageContext = {
      database,
      partitionId: "20000000-0000-4000-8000-000000000001",
      ownerId: "10000000-0000-4000-8000-000000000001",
    };
    const primitives = createMemoryMutationPrimitives();
    const ids = ["40000000-0000-4000-8000-00000000000a", "40000000-0000-4000-8000-00000000000b"];
    const inserted = await database.transaction((transaction) =>
      primitives.insertMemoriesInTransaction(
        transaction,
        storage,
        // A host's own ids may be uppercase; PostgreSQL returns uuid in lowercase.
        ids.map((id, index) => ({
          id: index === 0 ? id.toUpperCase() : id,
          scope: "shared",
          content: `Imported harbor fact ${index}.`,
          metadata: { index },
        })),
      ),
    );
    expect(inserted).toEqual({ memories: ids.map((id) => ({ id, version: 1 })) });

    const graph = createMemoryGraphModule(storage);
    const endpoints = { sourceMemoryId: ids[0] as string, targetMemoryId: ids[1] as string };
    const connected = await graph.connect(endpoints);
    expect(connected).toMatchObject({ created: true, link: { kind: "related", weight: 1 } });
    expect(connected?.link.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    // A repeat with the same values is the same Link, unchanged.
    await expect(graph.connect(endpoints)).resolves.toEqual({
      link: connected?.link,
      created: false,
    });
    const reweighted = await graph.connect({
      ...endpoints,
      weight: 0.25,
      metadata: { by: "host" },
    });
    expect(reweighted).toMatchObject({
      created: false,
      link: { id: connected?.link.id, weight: 0.25, metadata: { by: "host" } },
    });
    // An endpoint the store cannot see answers null, not a foreign-key failure.
    await expect(
      graph.connect({ ...endpoints, targetMemoryId: "40000000-0000-4000-8000-0000000000ff" }),
    ).resolves.toBeNull();
    await expect(graph.disconnect({ ...endpoints, kind: "cites" })).resolves.toBe(false);
    await expect(graph.disconnect(endpoints)).resolves.toBe(true);
    await expect(graph.disconnect(endpoints)).resolves.toBe(false);
    await expect(graph.connect(endpoints)).resolves.toMatchObject({ created: true });
    await expect(
      database.transaction((transaction) =>
        insertMemoryLinksInTransaction(transaction, storage.partitionId, [
          { sourceMemoryId: ids[0] as string, targetMemoryId: ids[1] as string },
          { sourceMemoryId: ids[1] as string, targetMemoryId: ids[0] as string, kind: "cites" },
        ]),
      ),
    ).resolves.toHaveLength(1);
    await expect(
      database.transaction((transaction) =>
        insertMemoryLinksInTransaction(transaction, storage.partitionId, [
          { sourceMemoryId: ids[0] as string, targetMemoryId: ids[0] as string },
        ]),
      ),
    ).rejects.toBeInstanceOf(LoreValidationError);
    await expect(graph.read()).resolves.toMatchObject({
      nodes: expect.arrayContaining([expect.objectContaining({ id: ids[0] })]),
      links: expect.arrayContaining([expect.objectContaining({ kind: "cites" })]),
    });

    await expect(
      database.transaction((transaction) =>
        primitives.forgetMemoryInTransaction(transaction, storage, ids[0] as string, {
          expectedVersion: 2,
        }),
      ),
    ).rejects.toBeInstanceOf(MemoryVersionConflictError);
    // A host that already locked the row may still forget it in the same transaction.
    await expect(
      database.transaction(async (transaction) => {
        await transaction.query("SELECT version FROM memories WHERE id = $1 FOR UPDATE", [ids[0]]);
        return primitives.forgetMemoryInTransaction(transaction, storage, ids[0] as string, {
          expectedVersion: 1,
        });
      }),
    ).resolves.toBe(true);
    const links = await postgres.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM memory_links",
    );
    expect(links.rows[0]?.count).toBe(0);
  } finally {
    await postgres.close();
  }
});
