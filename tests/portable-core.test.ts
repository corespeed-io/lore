import { expect, test } from "vitest";
import { installActorContext } from "@/lib/actor-context";
import type { PostgresDatabase } from "@/lib/db";
import { createMemoryGraphModule } from "@/lib/graph";
import { IdempotencyConflictError, mutationRequestHash } from "@/lib/idempotency";
import { purgeExpiredPortableCoreRecords } from "@/lib/maintenance";
import { createMemoryModule, MemoryVersionConflictError } from "@/lib/memory";
import { createOperationsModule } from "@/lib/operations";
import {
  createPortabilityModule,
  MAX_WORKSPACE_ARCHIVE_LINKS,
  MAX_WORKSPACE_ARCHIVE_MEMORIES,
  PortabilityValidationError,
  WorkspaceExportLimitError,
} from "@/lib/portability";
import { markDependencyFailure, markDependencySuccess } from "@/lib/telemetry";
import { createMemoryTestContext } from "./support/memory-context";

const EXPORT_TEST_DEPLOYMENT_ID = "30000000-0000-4000-8000-000000000001";

function exportLimitDatabase(options: {
  linkCount?: number;
  memoryCount: number;
  queries: string[];
}): PostgresDatabase {
  const memory = {
    id: "40000000-0000-4000-8000-000000000001",
    owner_user_id: "10000000-0000-4000-8000-000000000001",
    scope: "shared",
    content: "Bounded export sentinel.",
    metadata: {},
    version: 1,
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
  };
  const link = {
    id: "50000000-0000-4000-8000-000000000001",
    source_memory_id: memory.id,
    target_memory_id: memory.id,
    kind: "related",
    weight: 1,
    metadata: {},
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
  };
  return {
    transaction: (use) =>
      use({
        async query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> {
          options.queries.push(sql);
          if (sql.includes("set_config('lore.workspace_id'")) return { rows: [] };
          if (sql.includes("portable_core_capabilities")) {
            return {
              rows: [
                { capabilities: { deploymentId: EXPORT_TEST_DEPLOYMENT_ID } },
              ] as unknown as Row[],
            };
          }
          if (sql.includes("FROM memories")) {
            expect(sql).toContain("LIMIT $2");
            expect(params?.[1]).toBe(MAX_WORKSPACE_ARCHIVE_MEMORIES + 1);
            return {
              rows: Array(options.memoryCount).fill(memory) as unknown as Row[],
            };
          }
          if (sql.includes("FROM memory_links")) {
            expect(sql).toContain("LIMIT $3");
            expect(params?.[2]).toBe(MAX_WORKSPACE_ARCHIVE_LINKS + 1);
            return {
              rows: Array(options.linkCount ?? 0).fill(link) as unknown as Row[],
            };
          }
          throw new Error(`Unexpected export test query: ${sql}`);
        },
      }),
  };
}

test("Memory create replays the same Idempotency-Key and rejects a changed payload", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const operation = "memory.create";
  const firstInput = { content: "Replay-safe Memory." };
  const requestHash = await mutationRequestHash({ operation, payload: firstInput });

  const first = await memories.remember(testContext.alice, firstInput, {
    idempotency: { key: "portable-core-create", operation, requestHash },
  });
  const replay = await memories.remember(testContext.alice, firstInput, {
    idempotency: { key: "portable-core-create", operation, requestHash },
  });

  expect(replay).toEqual(first);
  await expect(
    memories.remember(
      testContext.alice,
      { content: "Changed payload." },
      {
        idempotency: {
          key: "portable-core-create",
          operation,
          requestHash: await mutationRequestHash({
            operation,
            payload: { content: "Changed payload." },
          }),
        },
      },
    ),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  await expect(memories.list(testContext.alice)).resolves.toHaveLength(1);
});

test("portable record retention runs without an embedding provider", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const operation = "memory.create";
  const input = { content: "Expire the replay response and content-free event." };
  await memories.remember(testContext.alice, input, {
    idempotency: {
      key: "portable-core-expiry",
      operation,
      requestHash: await mutationRequestHash({ operation, payload: input }),
    },
  });
  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      "UPDATE request_idempotency_records SET expires_at = now() - interval '1 second'",
    );
    await transaction.query("UPDATE memory_events SET expires_at = now() - interval '1 second'");
  });

  await expect(purgeExpiredPortableCoreRecords(testContext.maintenanceDatabase)).resolves.toEqual({
    idempotencyRecords: 1,
    memoryEvents: 1,
  });
  const remaining = await testContext.adminDatabase.transaction(async (transaction) => ({
    events: (await transaction.query("SELECT id FROM memory_events")).rows,
    idempotency: (await transaction.query("SELECT id FROM request_idempotency_records")).rows,
  }));
  expect(remaining).toEqual({ events: [], idempotency: [] });
});

test("optimistic Memory updates allow one writer and reject a stale writer", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const created = await memories.remember(testContext.alice, { content: "Version one." });

  const first = await memories.update(
    testContext.alice,
    created.id,
    { content: "Version two." },
    { expectedVersion: created.version },
  );
  expect(first?.version).toBe(2);
  await expect(
    memories.update(
      testContext.alice,
      created.id,
      { scope: "private" },
      { expectedVersion: created.version },
    ),
  ).rejects.toBeInstanceOf(MemoryVersionConflictError);

  await expect(memories.retrieve(testContext.alice, created.id)).resolves.toMatchObject({
    content: "Version two.",
    scope: "shared",
    version: 2,
  });
});

test("concurrent writers cannot rebuild chunks from a stale pre-read", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const created = await memories.remember(testContext.alice, {
    content: "Original content used by both clients.",
  });

  const writes = await Promise.allSettled([
    memories.update(
      testContext.alice,
      created.id,
      { content: "Winner A content." },
      { expectedVersion: created.version },
    ),
    memories.update(
      testContext.alice,
      created.id,
      { content: "Winner B content." },
      { expectedVersion: created.version },
    ),
  ]);
  expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
  expect(writes.filter((write) => write.status === "rejected")).toHaveLength(1);
  expect(writes.find((write) => write.status === "rejected")).toMatchObject({
    reason: expect.any(MemoryVersionConflictError),
  });

  const memory = await memories.retrieve(testContext.alice, created.id);
  const chunks = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ content: string }>(
      "SELECT content FROM memory_chunks WHERE memory_id = $1 ORDER BY ordinal",
      [created.id],
    ),
  );
  expect(chunks.rows.map((chunk) => chunk.content).join("\n")).toBe(memory?.content);
  expect(memory?.version).toBe(2);
});

test("Idempotency-Key scope is isolated by actor", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const operation = "memory.create";
  const input = { content: "The same request key is safe for different actors." };
  const idempotency = {
    key: "shared-client-retry-key",
    operation,
    requestHash: await mutationRequestHash({ operation, payload: input }),
  };

  await memories.remember(testContext.alice, input, { idempotency });
  await memories.remember(testContext.bob, input, { idempotency });

  const aliceRows = await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    return transaction.query<{ actor_user_id: string }>(
      "SELECT actor_user_id FROM request_idempotency_records",
    );
  });
  expect(aliceRows.rows).toEqual([{ actor_user_id: testContext.alice.userId }]);
});

test("hard deletion scrubs prior idempotent response bodies containing Memory content", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const input = { content: "Delete this replay payload completely." };
  const operation = "memory.create";
  const created = await memories.remember(testContext.alice, input, {
    idempotency: {
      key: "create-then-delete",
      operation,
      requestHash: await mutationRequestHash({ operation, payload: input }),
    },
  });

  await expect(memories.forget(testContext.alice, created.id)).resolves.toBe(true);
  const records = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ response_body: unknown }>(
      "SELECT response_body FROM request_idempotency_records",
    ),
  );
  expect(JSON.stringify(records.rows)).not.toContain(created.id);
  expect(JSON.stringify(records.rows)).not.toContain(input.content);
});

test("transactional Memory events survive hard deletion without retaining content", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const privateMemory = await memories.remember(testContext.alice, {
    content: "Private content must not enter the outbox.",
    scope: "private",
  });
  const sharedMemory = await memories.remember(testContext.alice, {
    content: "Shared event visibility.",
  });
  await memories.update(testContext.alice, privateMemory.id, { metadata: { reviewed: true } });
  await memories.forget(testContext.alice, privateMemory.id);

  const aliceEvents = await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    return transaction.query<{
      event_type: string;
      resource_id: string;
      before_content_sha256: string | null;
      after_content_sha256: string | null;
    }>(
      `SELECT event_type, resource_id, before_content_sha256, after_content_sha256
       FROM memory_events
       ORDER BY sequence`,
    );
  });
  const durableEvents = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ event_type: string }>(
      "SELECT event_type FROM memory_events ORDER BY sequence",
    ),
  );
  expect(durableEvents.rows.map((event) => event.event_type)).toEqual([
    "memory.created",
    "memory.created",
    "memory.updated",
    "memory.deleted",
  ]);
  expect(aliceEvents.rows.map((event) => event.event_type)).toEqual([
    "memory.created",
    "memory.deleted",
  ]);
  expect(aliceEvents.rows.at(-1)).toMatchObject({
    resource_id: privateMemory.id,
    before_content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    after_content_sha256: null,
  });

  const bobEvents = await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.bob);
    return transaction.query<{ resource_id: string }>("SELECT resource_id FROM memory_events");
  });
  expect(bobEvents.rows).toEqual([{ resource_id: sharedMemory.id }]);

  const carolEvents = await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.carol);
    return transaction.query("SELECT resource_id FROM memory_events");
  });
  expect(carolEvents.rows).toEqual([]);
});

test("Memory Link mutations append content-free events in the same transaction", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const source = await memories.remember(testContext.alice, { content: "Source" });
  const target = await memories.remember(testContext.alice, { content: "Target" });
  const link = await graph.connect(testContext.alice, {
    sourceMemoryId: source.id,
    targetMemoryId: target.id,
    kind: "supports",
  });

  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    await transaction.query("DELETE FROM memory_links WHERE id = $1", [link.id]);
  });
  const result = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{
      after_content_sha256: string | null;
      before_content_sha256: string | null;
      event_type: string;
      resource_id: string;
      resource_type: string;
    }>(
      `SELECT resource_type, resource_id, event_type,
              before_content_sha256, after_content_sha256
       FROM memory_events
       WHERE resource_type = 'memory_link'
       ORDER BY sequence`,
    ),
  );
  expect(result.rows).toEqual([
    {
      resource_type: "memory_link",
      resource_id: link.id,
      event_type: "memory_link.created",
      before_content_sha256: null,
      after_content_sha256: null,
    },
    {
      resource_type: "memory_link",
      resource_id: link.id,
      event_type: "memory_link.deleted",
      before_content_sha256: null,
      after_content_sha256: null,
    },
  ]);

  await memories.update(testContext.alice, target.id, { scope: "private" });
  const bobLinkEvents = await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.bob);
    return transaction.query(
      "SELECT resource_id FROM memory_events WHERE resource_type = 'memory_link'",
    );
  });
  expect(bobLinkEvents.rows).toEqual([]);

  const bobTargetEvents = await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.bob);
    return transaction.query(
      "SELECT resource_id FROM memory_events WHERE resource_type = 'memory' AND resource_id = $1",
      [target.id],
    );
  });
  expect(bobTargetEvents.rows).toEqual([]);
});

test("Workspace export is actor-visible, checksummed, dry-runnable, and replay-safe on import", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const portability = createPortabilityModule(testContext.database);
  const alicePrivate = await memories.remember(testContext.alice, {
    content: "Alice portable private Memory.",
    scope: "private",
  });
  const aliceShared = await memories.remember(testContext.alice, {
    content: "Alice portable shared Memory.",
  });
  const bobPrivate = await memories.remember(testContext.bob, {
    content: "Bob private Memory must not export for Alice.",
    scope: "private",
  });
  const bobShared = await memories.remember(testContext.bob, {
    content: "Bob shared Memory is visible to Alice.",
  });
  await graph.connect(testContext.alice, {
    sourceMemoryId: aliceShared.id,
    targetMemoryId: bobShared.id,
    kind: "related",
  });

  const archive = await portability.exportWorkspace(testContext.alice);
  expect(archive.memories.map((memory) => memory.id).sort()).toEqual(
    [alicePrivate.id, aliceShared.id, bobShared.id].sort(),
  );
  expect(archive.memories.map((memory) => memory.id)).not.toContain(bobPrivate.id);
  expect(archive.links).toHaveLength(1);
  expect(archive.manifest.checksum).toMatch(/^[0-9a-f]{64}$/);

  const ownerMap = Object.fromEntries(
    [...new Set(archive.memories.map((memory) => memory.ownerUserId))].map((owner) => [
      owner,
      testContext.carol.userId,
    ]),
  );
  const dryRun = await portability.importWorkspace(testContext.carol, {
    archive,
    ownerMap,
    dryRun: true,
  });
  expect(dryRun).toMatchObject({ dryRun: true, importedMemories: 3, importedLinks: 1 });
  await expect(memories.list(testContext.carol)).resolves.toEqual([]);

  const imported = await portability.importWorkspace(testContext.carol, { archive, ownerMap });
  expect(imported).toMatchObject({
    dryRun: false,
    importedMemories: 3,
    importedLinks: 1,
    replayed: false,
  });
  const replayed = await portability.importWorkspace(testContext.carol, { archive, ownerMap });
  expect(replayed).toMatchObject({ ...imported, replayed: true });
  await expect(memories.list(testContext.carol)).resolves.toHaveLength(3);

  const tampered = structuredClone(archive);
  tampered.memories[0].content = "Tampered content";
  await expect(
    portability.importWorkspace(testContext.carol, { archive: tampered, ownerMap }),
  ).rejects.toBeInstanceOf(PortabilityValidationError);
});

test("Workspace export stops at the visible Memory sentinel before querying Links", async () => {
  const queries: string[] = [];
  const portability = createPortabilityModule(
    exportLimitDatabase({ memoryCount: MAX_WORKSPACE_ARCHIVE_MEMORIES + 1, queries }),
  );

  await expect(
    portability.exportWorkspace({
      workspaceId: "20000000-0000-4000-8000-000000000001",
      userId: "10000000-0000-4000-8000-000000000001",
    }),
  ).rejects.toMatchObject({
    code: "workspace_export_limit_exceeded",
    status: 409,
  } satisfies Partial<WorkspaceExportLimitError>);
  expect(queries.some((query) => query.includes("FROM memory_links"))).toBe(false);
});

test("Workspace export stops at the visible Link sentinel", async () => {
  const queries: string[] = [];
  const portability = createPortabilityModule(
    exportLimitDatabase({
      linkCount: MAX_WORKSPACE_ARCHIVE_LINKS + 1,
      memoryCount: 1,
      queries,
    }),
  );

  await expect(
    portability.exportWorkspace({
      workspaceId: "20000000-0000-4000-8000-000000000001",
      userId: "10000000-0000-4000-8000-000000000001",
    }),
  ).rejects.toBeInstanceOf(WorkspaceExportLimitError);
  expect(queries.filter((query) => query.includes("FROM memory_links"))).toHaveLength(1);
});

test("Workspace import cannot reveal an RLS-hidden Memory id collision", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const portability = createPortabilityModule(testContext.database);
  const hidden = await memories.remember(testContext.bob, {
    content: "Bob's private collision sentinel.",
    scope: "private",
  });
  await memories.remember(testContext.carol, { content: "Portable source Memory." });
  const archive = await portability.exportWorkspace(testContext.carol);
  const sourceOwner = archive.memories[0].ownerUserId;
  archive.memories[0].id = hidden.id;
  const { checksum: _checksum, ...manifest } = archive.manifest;
  archive.manifest.checksum = await mutationRequestHash({
    manifest,
    memories: archive.memories,
    links: archive.links,
  });

  const imported = await portability.importWorkspace(testContext.alice, {
    archive,
    conflictPolicy: "error",
    ownerMap: { [sourceOwner]: testContext.alice.userId },
  });

  expect(imported.memoryIdMap[hidden.id]).not.toBe(hidden.id);
  await expect(memories.retrieve(testContext.alice, hidden.id)).resolves.toBeNull();
  await expect(
    memories.retrieve(testContext.alice, imported.memoryIdMap[hidden.id]),
  ).resolves.toMatchObject({ content: "Portable source Memory." });
});

test("Workspace import normalizes UUID case before owner and Link mapping", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const portability = createPortabilityModule(testContext.database);
  const source = await memories.remember(testContext.carol, { content: "Uppercase source." });
  const target = await memories.remember(testContext.carol, { content: "Uppercase target." });
  await graph.connect(testContext.carol, {
    sourceMemoryId: source.id,
    targetMemoryId: target.id,
    kind: "normalized",
  });
  const archive = await portability.exportWorkspace(testContext.carol);
  archive.manifest.sourceDeploymentId = archive.manifest.sourceDeploymentId.toUpperCase();
  archive.manifest.sourceWorkspaceId = archive.manifest.sourceWorkspaceId.toUpperCase();
  for (const memory of archive.memories) {
    memory.id = memory.id.toUpperCase();
    memory.ownerUserId = memory.ownerUserId.toUpperCase();
  }
  for (const link of archive.links) {
    link.id = link.id.toUpperCase();
    link.sourceMemoryId = link.sourceMemoryId.toUpperCase();
    link.targetMemoryId = link.targetMemoryId.toUpperCase();
  }
  const { checksum: _checksum, ...manifest } = archive.manifest;
  archive.manifest.checksum = await mutationRequestHash({
    manifest,
    memories: archive.memories,
    links: archive.links,
  });
  const ownerMap = {
    [testContext.carol.userId.toUpperCase()]: testContext.alice.userId.toUpperCase(),
  };

  const imported = await portability.importWorkspace(testContext.alice, { archive, ownerMap });

  expect(imported).toMatchObject({ importedMemories: 2, importedLinks: 1 });
  expect(Object.keys(imported.memoryIdMap).sort()).toEqual([source.id, target.id].sort());
});

test("Workspace import rejects oversized metadata before queueing every child", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const portability = createPortabilityModule(testContext.database);
  await memories.remember(testContext.carol, { content: "Bound imported metadata." });
  const archive = await portability.exportWorkspace(testContext.carol);
  archive.memories[0].metadata = { items: Array.from({ length: 10_001 }, () => null) };
  const { checksum: _checksum, ...manifest } = archive.manifest;
  archive.manifest.checksum = await mutationRequestHash({
    manifest,
    memories: archive.memories,
    links: archive.links,
  });

  await expect(
    portability.importWorkspace(testContext.alice, {
      archive,
      ownerMap: { [testContext.carol.userId]: testContext.alice.userId },
    }),
  ).rejects.toThrow(/exceeds 10000 values/);
});

test("Portable Core readiness checks schema, vector, and the RLS request role", async () => {
  const testContext = await createMemoryTestContext();
  const operations = createOperationsModule(testContext.database, { embeddingConfigured: true });

  await expect(operations.capabilities()).resolves.toMatchObject({
    apiVersion: "v1",
    schemaRevision: 6,
    features: {
      idempotency: true,
      optimisticConcurrency: true,
      transactionalOutbox: true,
    },
    limits: {
      workspaceArchiveLinks: MAX_WORKSPACE_ARCHIVE_LINKS,
      workspaceArchiveMemories: MAX_WORKSPACE_ARCHIVE_MEMORIES,
    },
  });
  await expect(operations.readiness()).resolves.toMatchObject({
    status: "ready",
    components: {
      database: "ok",
      rlsRole: "ok",
      schema: "ok",
      vector: "ok",
    },
  });

  markDependencyFailure("embedding");
  try {
    await expect(operations.readiness()).resolves.toMatchObject({
      status: "degraded",
      components: {
        database: "ok",
        embedding: "degraded",
        rlsRole: "ok",
        schema: "ok",
        vector: "ok",
      },
    });
  } finally {
    markDependencySuccess("embedding");
  }

  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query("UPDATE lore_system_state SET schema_revision = 3 WHERE singleton"),
  );
  await expect(operations.readiness()).resolves.toMatchObject({
    status: "unready",
    components: { schema: "incompatible" },
  });
  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query("UPDATE lore_system_state SET schema_revision = 6 WHERE singleton"),
  );

  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query("ALTER TABLE memories DISABLE ROW LEVEL SECURITY"),
  );
  await expect(operations.readiness()).resolves.toMatchObject({
    status: "unready",
    components: { rlsRole: "unavailable" },
  });
});
