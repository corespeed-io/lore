import type { EmbeddingTask, PostgresDatabase } from "@corespeed/lore-core";
import { createMemoryMaintenanceModule, transactionThrough } from "@corespeed/lore-core";
import { afterEach, expect, test } from "vitest";
import { createMemoryGraphModule } from "@/modules/graph/service";
import { createMemoryModule } from "@/modules/memories/service";
import { workspaceArchiveChecksum } from "@/modules/portability/checksum";
import {
  createPortabilityModule,
  exportedTimestamp,
  PortabilityValidationError,
  type WorkspaceArchive,
  WorkspaceExportLimitError,
} from "@/modules/portability/service";
import { createApi } from "@/server/api/app";
import type { ActorContext } from "@/server/auth/actor-context";
import { createMemoryTestContext, type MemoryTestContext } from "../../support/memory-context";

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) {
    delete process.env[key];
  }
});

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
    transaction: (use, options) =>
      database.transaction(
        (transaction) =>
          use(
            transactionThrough(transaction, (sql, params) => {
              statements.push(sql);
              return transaction.query(sql, params);
            }),
          ),
        options,
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
  const batches: number[] = [];
  const portability = createPortabilityModule(testContext.database, {
    embeddingProvider: provider,
    maintenanceNotifier: {
      notify: () => {
        throw new Error("A bulk import must use the batched notifier when the host offers one");
      },
      notifyMany: (messages) => {
        batches.push(messages.length);
        notifications.push(...messages.map(({ jobId }) => jobId));
      },
    },
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
  expect(batches).toEqual([2]);
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

async function resigned(archive: WorkspaceArchive): Promise<WorkspaceArchive> {
  const { checksum: _checksum, ...manifest } = archive.manifest;
  archive.manifest.checksum = await workspaceArchiveChecksum(
    { manifest, memories: archive.memories, links: archive.links },
    manifest.format,
  );
  return archive;
}

/** Carol's two linked Memories, exported so that Alice can import them. */
async function linkedArchive(testContext: MemoryTestContext): Promise<WorkspaceArchive> {
  const memories = createMemoryModule(testContext.database);
  const source = await memories.remember(testContext.carol, { content: "Archive text source." });
  const target = await memories.remember(testContext.carol, { content: "Archive text target." });
  await createMemoryGraphModule(testContext.database).connect(testContext.carol, {
    sourceMemoryId: source.id,
    targetMemoryId: target.id,
    kind: "cites",
  });
  return createPortabilityModule(testContext.database).exportWorkspace(testContext.carol);
}

async function expectRefusedBeforeWrites(
  testContext: MemoryTestContext,
  archive: WorkspaceArchive,
  message: RegExp,
): Promise<void> {
  const portability = createPortabilityModule(testContext.database);
  const ownerMap = ownerMapTo(archive, testContext.alice);
  // The dry run must refuse exactly what the real import would refuse, and both must
  // refuse it as an archive validation error rather than a database failure.
  for (const dryRun of [true, false]) {
    const refused = portability.importWorkspace(testContext.alice, { archive, ownerMap, dryRun });
    await expect(refused).rejects.toBeInstanceOf(PortabilityValidationError);
    await expect(refused).rejects.toThrow(message);
  }
  const stored = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query("SELECT id FROM memories WHERE workspace_id = $1", [
      testContext.alice.workspaceId,
    ]),
  );
  expect(stored.rows).toEqual([]);
}

test.each<[string, (archive: WorkspaceArchive) => void, RegExp]>([
  [
    "a NUL in Memory content",
    (archive) => {
      archive.memories[0].content = "Null \u0000 content.";
    },
    /null character/,
  ],
  [
    "a lone surrogate in Memory content",
    (archive) => {
      archive.memories[0].content = "Lone \uD800 content.";
    },
    /memories\[0\]\.content/,
  ],
  [
    "a NUL in a Memory metadata string",
    (archive) => {
      archive.memories[0].metadata = { note: "a\u0000b" };
    },
    /memories\[0\]\.metadata contains a NUL character or invalid Unicode/,
  ],
  [
    "a NUL in a Memory metadata key",
    (archive) => {
      archive.memories[0].metadata = { "key\u0000": 1 };
    },
    /memories\[0\]\.metadata contains a NUL character or invalid Unicode/,
  ],
  [
    "a nested lone surrogate in Memory metadata",
    (archive) => {
      archive.memories[1].metadata = { deep: [{ value: "\uDC00 trailing" }] };
    },
    /memories\[1\]\.metadata contains a NUL character or invalid Unicode/,
  ],
  [
    "a NUL in Link metadata",
    (archive) => {
      archive.links[0].metadata = { note: ["ok", "bad\u0000"] };
    },
    /links\[0\]\.metadata contains a NUL character or invalid Unicode/,
  ],
  [
    "a lone surrogate in a Link kind",
    (archive) => {
      archive.links[0].kind = "cites\uD83D";
    },
    /links\[0\]\.kind must be non-blank text of at most 64 characters/,
  ],
  // The engine's Link and scope rules, reported as archive failures (invalid_archive),
  // never as the engine's own invalid_request.
  [
    "a Link from a Memory to itself",
    (archive) => {
      archive.links[0].targetMemoryId = archive.links[0].sourceMemoryId;
    },
    /links\[0\] must connect two different Memories/,
  ],
  [
    "a Link without a weight",
    (archive) => {
      delete (archive.links[0] as Partial<WorkspaceArchive["links"][number]>).weight;
    },
    /links\[0\] must include kind and weight/,
  ],
  [
    "a Link weight above 1",
    (archive) => {
      archive.links[0].weight = 1.5;
    },
    /links\[0\]\.weight must be a number from 0 through 1/,
  ],
  [
    "a Link weight PostgreSQL's real would round to zero",
    (archive) => {
      archive.links[0].weight = 1e-50;
    },
    /links\[0\]\.weight must be 0 or a value PostgreSQL real does not round to zero/,
  ],
  [
    "Link metadata past the Link bound, though within a Memory's",
    (archive) => {
      archive.links[0].metadata = { note: "m".repeat(1_000) };
    },
    /links\[0\]\.metadata exceeds 1000 characters/,
  ],
  [
    "an unknown Memory scope",
    (archive) => {
      (archive.memories[1] as { scope: string }).scope = "team";
    },
    /memories\[1\]\.scope must be shared or private/,
  ],
  [
    "a top-level __proto__ metadata key",
    (archive) => {
      archive.memories[0].metadata = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    },
    /memories\[0\]\.metadata must not contain a __proto__ key/,
  ],
  [
    "a nested __proto__ Link metadata key",
    (archive) => {
      archive.links[0].metadata = JSON.parse('{"nested":[{"__proto__":{"x":1}}]}');
    },
    /links\[0\]\.metadata must not contain a __proto__ key/,
  ],
])("import dry-run refuses %s, as the real import does", async (_name, mutate, message) => {
  const testContext = await createMemoryTestContext();
  const archive = await linkedArchive(testContext);
  mutate(archive);

  await expectRefusedBeforeWrites(testContext, await resigned(archive), message);
});

test.each<[string, (archive: WorkspaceArchive) => void]>([
  [
    "an impossible calendar day",
    (archive) => {
      archive.memories[0].createdAt = "2026-02-30T00:00:00.000Z";
    },
  ],
  [
    "year zero",
    (archive) => {
      archive.memories[0].updatedAt = "0000-06-01T00:00:00.000Z";
    },
  ],
  [
    "an expanded year",
    (archive) => {
      archive.links[0].createdAt = "+010000-01-01T00:00:00.000Z";
    },
  ],
  [
    "an offset PostgreSQL refuses",
    (archive) => {
      archive.links[0].updatedAt = "2026-01-01T00:00:00+16:00";
    },
  ],
  [
    "hour 24",
    (archive) => {
      archive.memories[0].createdAt = "2026-01-01T24:00:00Z";
    },
  ],
  [
    "a space separator",
    (archive) => {
      archive.manifest.exportedAt = "2026-01-01 00:00:00Z";
    },
  ],
  [
    "an epoch number",
    (archive) => {
      Object.assign(archive.memories[0], { createdAt: 1_767_225_600_000 });
    },
  ],
])("import dry-run refuses a timestamp with %s", async (_name, mutate) => {
  const testContext = await createMemoryTestContext();
  const archive = await linkedArchive(testContext);
  mutate(archive);

  await expectRefusedBeforeWrites(
    testContext,
    await resigned(archive),
    /must be an RFC 3339 timestamp|is out of range/,
  );
});

// The format picks the checksum's key order, so it is checked before the checksum is
// computed: an unknown one is an archive failure, never a failure to hash it.
test.each<[string, unknown]>([
  ["a later format", "lore-workspace-v3"],
  ["a format in the wrong case", "LORE-WORKSPACE-V2"],
  ["no format", undefined],
])("import dry-run refuses %s, as the real import does", async (_name, format) => {
  const testContext = await createMemoryTestContext();
  const archive = await linkedArchive(testContext);
  (archive.manifest as { format: unknown }).format = format;

  await expectRefusedBeforeWrites(
    testContext,
    archive,
    /^archive format must be lore-workspace-v1 or lore-workspace-v2$/,
  );
});

test("export writes lore-workspace-v2, and a lore-workspace-v1 archive still imports", async () => {
  const testContext = await createMemoryTestContext();
  const portability = createPortabilityModule(testContext.database);
  const archive = await linkedArchive(testContext);
  expect(archive.manifest.format).toBe("lore-workspace-v2");

  // An archive exported before v2: the same records, checksummed with v1's key order.
  archive.manifest.format = "lore-workspace-v1";
  await resigned(archive);
  await expect(
    portability.importWorkspace(testContext.alice, {
      archive,
      ownerMap: ownerMapTo(archive, testContext.alice),
      dryRun: true,
    }),
  ).resolves.toMatchObject({ dryRun: true, importedMemories: 2, importedLinks: 1 });

  // A checksum is verified in the format the manifest names: mixed-case keys sort
  // differently in v1, so a v2 manifest with a v1-ordered checksum is refused.
  archive.manifest.format = "lore-workspace-v2";
  archive.memories[0].metadata = { Zeta: 1, alpha: 2 };
  const { checksum: _checksum, ...manifest } = archive.manifest;
  archive.manifest.checksum = await workspaceArchiveChecksum(
    { manifest, memories: archive.memories, links: archive.links },
    "lore-workspace-v1",
  );
  await expect(
    portability.importWorkspace(testContext.alice, {
      archive,
      ownerMap: ownerMapTo(archive, testContext.alice),
      dryRun: true,
    }),
  ).rejects.toThrow("archive checksum does not match its records");
  await testContext.close();
});

test("every timestamp an import accepts is one PostgreSQL stores exactly", async () => {
  const testContext = await createMemoryTestContext();
  const archive = await linkedArchive(testContext);
  const bounds = {
    createdAt: "0001-01-01T00:00:00+15:59",
    updatedAt: "9999-12-31T23:59:59.999999-15:59",
  };
  Object.assign(archive.memories[0], bounds);
  archive.memories[1].createdAt = "2024-02-29T12:00:00Z";
  archive.links[0].createdAt = "2026-09-24T10:00:00.5+00:00";

  const imported = await createPortabilityModule(testContext.database).importWorkspace(
    testContext.alice,
    { archive: await resigned(archive), ownerMap: ownerMapTo(archive, testContext.alice) },
  );

  expect(imported).toMatchObject({ importedMemories: 2, importedLinks: 1 });
  const provenance = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ exact: boolean }>(
      `SELECT source_created_at = $2::timestamptz AND source_updated_at = $3::timestamptz AS exact
       FROM memory_import_provenance
       WHERE memory_id = $1`,
      [imported.memoryIdMap[archive.memories[0].id], bounds.createdAt, bounds.updatedAt],
    ),
  );
  expect(provenance.rows).toEqual([{ exact: true }]);
});

test("an import refuses a deeply nested field that only its checksum reads", async () => {
  const testContext = await createMemoryTestContext();
  const archive = await linkedArchive(testContext);
  let deep: Record<string, unknown> = {};
  for (let level = 0; level < 200_000; level += 1) deep = { level: deep };
  Object.assign(archive.memories[0], { annotations: deep });

  const refused = createPortabilityModule(testContext.database).importWorkspace(testContext.alice, {
    archive,
    ownerMap: ownerMapTo(archive, testContext.alice),
    dryRun: true,
  });
  await expect(refused).rejects.toBeInstanceOf(PortabilityValidationError);
  await expect(refused).rejects.toThrow("archive is too deeply nested");
});

test("export keeps millisecond timestamps and import provenance records them exactly", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const memory = await memories.remember(testContext.carol, { content: "Millisecond Memory." });
  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE memories
       SET created_at = '2026-01-02T03:04:05.678Z', updated_at = '2026-01-02T03:04:06.789Z'
       WHERE id = $1`,
      [memory.id],
    ),
  );
  const portability = createPortabilityModule(testContext.database);

  const archive = await portability.exportWorkspace(testContext.carol);

  expect(archive.memories[0]).toMatchObject({
    createdAt: "2026-01-02T03:04:05.678Z",
    updatedAt: "2026-01-02T03:04:06.789Z",
  });
  const imported = await portability.importWorkspace(testContext.alice, {
    archive,
    ownerMap: ownerMapTo(archive, testContext.alice),
  });
  const provenance = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ created: string; updated: string }>(
      `SELECT to_char(source_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS created,
              to_char(source_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS updated
       FROM memory_import_provenance
       WHERE memory_id = $1`,
      [imported.memoryIdMap[memory.id]],
    ),
  );
  expect(provenance.rows).toEqual([
    { created: "2026-01-02T03:04:05.678", updated: "2026-01-02T03:04:06.789" },
  ]);
});

test("a timestamp a driver returns as PostgreSQL text exports in the form import accepts", async () => {
  const testContext = await createMemoryTestContext();
  const text = await testContext.adminDatabase.transaction(async (transaction) => {
    const zones: Record<string, string> = {};
    for (const zone of ["UTC", "Asia/Kolkata", "America/St_Johns"]) {
      await transaction.query(`SELECT set_config('TimeZone', $1, true)`, [zone]);
      const result = await transaction.query<{ value: string }>(
        "SELECT '2026-01-02T03:04:05.678901Z'::timestamptz::text AS value",
      );
      zones[zone] = result.rows[0]?.value ?? "";
    }
    return zones;
  });

  expect(text.UTC).toBe("2026-01-02 03:04:05.678901+00");
  expect(exportedTimestamp(text.UTC ?? "")).toBe("2026-01-02T03:04:05.678901+00:00");
  expect(exportedTimestamp(text["Asia/Kolkata"] ?? "")).toBe("2026-01-02T08:34:05.678901+05:30");
  expect(exportedTimestamp(text["America/St_Johns"] ?? "")).toBe(
    "2026-01-01T23:34:05.678901-03:30",
  );
  expect(exportedTimestamp(new Date("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02T03:04:05.678Z");
  expect(() => exportedTimestamp("2026-02-30 00:00:00+00")).toThrow(
    "Database returned a timestamp outside the archive format",
  );
});

test("HTTP import answers an engine Link rule as 400 invalid_archive, dry run or not", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "portability-http-rules";
  const testContext = await createMemoryTestContext();
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  const workspace = (await (
    await app.request(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Import Rules" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const { userId } = (await (
    await app.request(new Request("http://lore.local/api/v1/actor", { headers }))
  ).json()) as { userId: string };
  const archive = await linkedArchive(testContext);
  // validateMemoryLink owns this rule; the archive must not surface it as the
  // engine's own invalid_request.
  archive.links[0].targetMemoryId = archive.links[0].sourceMemoryId;
  const signed = await resigned(archive);
  const ownerMap = Object.fromEntries(
    [...new Set(signed.memories.map((memory) => memory.ownerUserId))].map((owner) => [
      owner,
      userId,
    ]),
  );

  for (const dryRun of [true, false]) {
    const response = await app.request(
      new Request("http://lore.local/api/v1/workspaces/import", {
        method: "POST",
        headers,
        body: JSON.stringify({ archive: signed, ownerMap, dryRun }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "invalid_archive",
      error: "links[0] must connect two different Memories",
    });
  }
  const listed = await app.request(new Request("http://lore.local/api/memories", { headers }));
  await expect(listed.json()).resolves.toEqual([]);
  await testContext.close();
});
