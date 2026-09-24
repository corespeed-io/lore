import type { EmbeddingTask, PostgresDatabase } from "@corespeed/lore-core";
import { createMemoryMaintenanceModule } from "@corespeed/lore-core";
import { expect, test } from "vitest";
import { createMemoryGraphModule } from "@/modules/graph/service";
import { createMemoryModule } from "@/modules/memories/service";
import {
  createPortabilityModule,
  type WorkspaceArchive,
  WorkspaceExportLimitError,
} from "@/modules/portability/service";
import type { ActorContext } from "@/server/auth/actor-context";
import { createMemoryTestContext, type MemoryTestContext } from "../../support/memory-context";

function ownerMapTo(archive: WorkspaceArchive, actor: ActorContext): Record<string, string> {
  return Object.fromEntries(
    [...new Set(archive.memories.map((memory) => memory.ownerUserId))].map((owner) => [
      owner,
      actor.userId,
    ]),
  );
}

function archiveBytes(archive: WorkspaceArchive): number {
  return new TextEncoder().encode(JSON.stringify(archive)).length;
}

function countingDatabase(database: PostgresDatabase, statements: string[]): PostgresDatabase {
  return {
    transaction: (use) =>
      database.transaction((transaction) =>
        use({
          query: (sql, params) => {
            statements.push(sql);
            return transaction.query(sql, params);
          },
        }),
      ),
  };
}

async function workspaceLinks(context: MemoryTestContext, workspaceId: string) {
  return context.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ source_memory_id: string; target_memory_id: string }>(
      `SELECT source_memory_id, target_memory_id
       FROM memory_links
       WHERE workspace_id = $1
       ORDER BY source_memory_id, target_memory_id`,
      [workspaceId],
    );
    return result.rows.map((row) => [row.source_memory_id, row.target_memory_id]);
  });
}

test("metadata accepted by the wire schema survives an export and import round trip", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const portability = createPortabilityModule(testContext.database);
  let deep: Record<string, unknown> = { leaf: "bottom" };
  for (let level = 0; level < 34; level += 1) deep = { level: deep };
  const wide = { values: Array.from({ length: 15_000 }, (_, index) => index % 10) };
  expect(JSON.stringify(wide).length).toBeLessThan(100_000);
  await memories.remember(testContext.carol, { content: "Deep metadata.", metadata: deep });
  await memories.remember(testContext.carol, { content: "Wide metadata.", metadata: wide });

  const archive = await portability.exportWorkspace(testContext.carol);
  const imported = await portability.importWorkspace(testContext.alice, {
    archive,
    ownerMap: ownerMapTo(archive, testContext.alice),
  });

  expect(imported).toMatchObject({ importedMemories: 2, replayed: false });
  const restored = await memories.list(testContext.alice);
  expect(restored.map((memory) => memory.metadata)).toEqual(expect.arrayContaining([deep, wide]));
});

test("import writes each table in bounded set-based batches, not one round trip per row", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const created = [];
  for (let index = 0; index < 30; index += 1) {
    created.push(
      await memories.remember(testContext.carol, {
        // Two canonical chunks per Memory.
        content: `${"Batched import paragraph. ".repeat(50)}\n\nMemory ${index} tail.`,
      }),
    );
  }
  for (let index = 1; index < created.length; index += 1) {
    await graph.connect(testContext.carol, {
      sourceMemoryId: created[index - 1].id,
      targetMemoryId: created[index].id,
      kind: "next",
    });
  }
  const archive = await createPortabilityModule(testContext.database).exportWorkspace(
    testContext.carol,
  );
  const statements: string[] = [];
  const portability = createPortabilityModule(countingDatabase(testContext.database, statements));

  const imported = await portability.importWorkspace(testContext.alice, {
    archive,
    ownerMap: ownerMapTo(archive, testContext.alice),
  });

  expect(imported).toMatchObject({ importedMemories: 30, importedLinks: 29 });
  expect(statements.length).toBeLessThan(15);
  const chunkCounts = await testContext.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ chunks: number }>(
      `SELECT count(*)::integer AS chunks
       FROM memory_chunks
       WHERE workspace_id = $1
       GROUP BY memory_id`,
      [testContext.alice.workspaceId],
    );
    return result.rows.map((row) => row.chunks);
  });
  expect(chunkCounts).toEqual(Array(30).fill(2));
  const imports = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ memory_id: string }>(
      "SELECT memory_id FROM memory_import_provenance WHERE workspace_id = $1",
      [testContext.alice.workspaceId],
    ),
  );
  expect(imports.rows.map((row) => row.memory_id).sort()).toEqual(
    Object.values(imported.memoryIdMap).sort(),
  );
});

test("export enforces its archive byte budget at the exact boundary", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const first = await memories.remember(testContext.carol, { content: "Budgeted first." });
  const second = await memories.remember(testContext.carol, { content: "Budgeted second Memory." });
  // JSON content (length + 2 quotes) + "{}" metadata + 256 per Memory, plus the manifest.
  const memoryBytes = 1_024 + first.content.length + 260 + (second.content.length + 260);
  const exportWith = (maximumArchiveBytes: number) =>
    createPortabilityModule(testContext.database, { maximumArchiveBytes }).exportWorkspace(
      testContext.carol,
    );

  const exact = await exportWith(memoryBytes);
  expect(exact.memories).toHaveLength(2);
  expect(archiveBytes(exact)).toBeLessThanOrEqual(memoryBytes);
  await expect(exportWith(memoryBytes - 1)).rejects.toMatchObject({
    code: "workspace_export_limit_exceeded",
    status: 409,
  } satisfies Partial<WorkspaceExportLimitError>);

  await graph.connect(testContext.carol, {
    sourceMemoryId: first.id,
    targetMemoryId: second.id,
    kind: "related",
  });
  // JSON kind "related" (9) + "{}" metadata + 320 per Link.
  const linkedBytes = memoryBytes + 9 + 2 + 320;
  await expect(exportWith(linkedBytes)).resolves.toMatchObject({ links: [expect.any(Object)] });
  await expect(exportWith(linkedBytes - 1)).rejects.toBeInstanceOf(WorkspaceExportLimitError);
});

test("every archive that fits the export budget also fits it when serialized", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  await memories.remember(testContext.carol, {
    content: 'Escapes "quoted" \\ and\ttabs\nnewlines, 日本語のメモ, and emoji 🧠.',
    metadata: { nested: { list: [1.5, -2, 1e21, "é", null, true] }, "k\u0001": "v\u0002" },
  });
  await memories.remember(testContext.carol, { content: "\u0007".concat("Control start.") });
  const exportWith = (maximumArchiveBytes: number) =>
    createPortabilityModule(testContext.database, { maximumArchiveBytes }).exportWorkspace(
      testContext.carol,
    );
  const actual = archiveBytes(await exportWith(1_000_000));
  // Find the smallest budget export accepts; the archive must never exceed it.
  let rejected = 0;
  let accepted = 1_000_000;
  while (accepted - rejected > 1) {
    const budget = Math.floor((accepted + rejected) / 2);
    try {
      await exportWith(budget);
      accepted = budget;
    } catch (error) {
      if (!(error instanceof WorkspaceExportLimitError)) throw error;
      rejected = budget;
    }
  }
  expect(actual).toBeLessThanOrEqual(accepted);
});

test("an import receipt replays only while its imported Memories still exist", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const portability = createPortabilityModule(testContext.database);
  const [first, second, third] = [
    await memories.remember(testContext.carol, { content: "Receipt first." }),
    await memories.remember(testContext.carol, { content: "Receipt second." }),
    await memories.remember(testContext.carol, { content: "Receipt third." }),
  ];
  await graph.connect(testContext.carol, {
    sourceMemoryId: first.id,
    targetMemoryId: second.id,
    kind: "next",
  });
  await graph.connect(testContext.carol, {
    sourceMemoryId: second.id,
    targetMemoryId: third.id,
    kind: "next",
  });
  const archive = await portability.exportWorkspace(testContext.carol);
  const ownerMap = ownerMapTo(archive, testContext.alice);
  const importAgain = (dryRun = false) =>
    portability.importWorkspace(testContext.alice, { archive, ownerMap, dryRun });

  const original = await importAgain();
  expect(original).toMatchObject({ importedMemories: 3, importedLinks: 2, replayed: false });
  await expect(importAgain()).resolves.toMatchObject({ ...original, replayed: true });

  // Deleting one imported Memory makes the next import restore only that Memory and
  // reconnect it to the survivors instead of silently replaying the old receipt.
  await expect(memories.forget(testContext.alice, original.memoryIdMap[second.id])).resolves.toBe(
    true,
  );
  await expect(importAgain(true)).resolves.toMatchObject({
    dryRun: true,
    importedMemories: 1,
    importedLinks: 2,
    replayed: false,
  });
  const restored = await importAgain();
  expect(restored).toMatchObject({ importedMemories: 1, importedLinks: 2, replayed: false });
  expect(restored.memoryIdMap[first.id]).toBe(original.memoryIdMap[first.id]);
  expect(restored.memoryIdMap[third.id]).toBe(original.memoryIdMap[third.id]);
  expect(restored.memoryIdMap[second.id]).not.toBe(original.memoryIdMap[second.id]);
  await expect(memories.list(testContext.alice)).resolves.toHaveLength(3);
  await expect(workspaceLinks(testContext, testContext.alice.workspaceId)).resolves.toEqual(
    [
      [restored.memoryIdMap[first.id], restored.memoryIdMap[second.id]],
      [restored.memoryIdMap[second.id], restored.memoryIdMap[third.id]],
    ].sort(),
  );
  await expect(importAgain()).resolves.toMatchObject({ ...restored, replayed: true });

  for (const id of Object.values(restored.memoryIdMap)) {
    await memories.forget(testContext.alice, id);
  }
  const reimported = await importAgain();
  expect(reimported).toMatchObject({ importedMemories: 3, importedLinks: 2, replayed: false });
  await expect(memories.list(testContext.alice)).resolves.toHaveLength(3);
  await expect(importAgain()).resolves.toMatchObject({ ...reimported, replayed: true });
});

test("import enqueues embedding jobs in its transaction and notifies them after commit", async () => {
  const testContext = await createMemoryTestContext();
  const tasks: EmbeddingTask[] = [];
  const provider = {
    provider: "fixture",
    model: "fixture-embedding-v1",
    dimensions: 1024,
    revision: "fixture-v1",
    async embed(texts: string[], task: EmbeddingTask) {
      tasks.push(task);
      return texts.map(() => Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0)));
    },
  };
  const memories = createMemoryModule(testContext.database);
  await memories.remember(testContext.carol, { content: "Imported embedding first." });
  await memories.remember(testContext.carol, { content: "Imported embedding second." });
  const archive = await createPortabilityModule(testContext.database).exportWorkspace(
    testContext.carol,
  );
  const notifications: string[] = [];
  const portability = createPortabilityModule(testContext.database, {
    embeddingProvider: provider,
    maintenanceNotifier: { notify: ({ jobId }) => notifications.push(jobId) },
  });

  const dryRun = await portability.importWorkspace(testContext.alice, {
    archive,
    ownerMap: ownerMapTo(archive, testContext.alice),
    dryRun: true,
  });
  expect(dryRun.dryRun).toBe(true);
  expect(notifications).toEqual([]);
  const imported = await portability.importWorkspace(testContext.alice, {
    archive,
    ownerMap: ownerMapTo(archive, testContext.alice),
  });

  expect(notifications).toHaveLength(2);
  const jobs = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ id: string; memory_id: string; status: string }>(
      "SELECT id, memory_id, status FROM memory_embedding_jobs WHERE workspace_id = $1",
      [testContext.alice.workspaceId],
    ),
  );
  expect(jobs.rows.map((job) => job.id).sort()).toEqual([...notifications].sort());
  expect(jobs.rows.map((job) => job.memory_id).sort()).toEqual(
    Object.values(imported.memoryIdMap).sort(),
  );
  expect(jobs.rows.every((job) => job.status === "pending")).toBe(true);
  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: provider,
  });
  await expect(maintenance.run(notifications[0])).resolves.toMatchObject({ status: "complete" });
  expect(tasks).toEqual(["document"]);

  // A replayed import creates no new work.
  await portability.importWorkspace(testContext.alice, {
    archive,
    ownerMap: ownerMapTo(archive, testContext.alice),
  });
  expect(notifications).toHaveLength(2);
});
