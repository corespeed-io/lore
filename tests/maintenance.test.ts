import { expect, test } from "vitest";
import { installActorContext } from "@/lib/actor-context";
import { createMemoryMaintenanceModule } from "@/lib/maintenance";
import { createMemoryModule, type EmbeddingTask } from "@/lib/memory";
import { createMemoryTestContext } from "./support/memory-context";

function fixtureVector(index: number): number[] {
  return Array.from({ length: 1024 }, (_, vectorIndex) => (vectorIndex === index ? 1 : 0));
}

function fixtureProvider(embed: (texts: string[], task: EmbeddingTask) => Promise<number[][]>) {
  return {
    provider: "fixture",
    model: "fixture-embedding-v1",
    dimensions: 1024 as const,
    revision: "fixture-v1",
    embed,
  };
}

test("Memory writes enqueue document embeddings without waiting for the provider", async () => {
  const testContext = await createMemoryTestContext();
  const tasks: EmbeddingTask[] = [];
  const notifications: string[] = [];
  const provider = fixtureProvider(async (texts, task) => {
    tasks.push(task);
    return texts.map(() => fixtureVector(0));
  });
  const memories = createMemoryModule(testContext.database, {
    embeddingProvider: provider,
    maintenanceNotifier: { notify: ({ jobId }) => notifications.push(jobId) },
  });

  const created = await memories.remember(testContext.alice, {
    content: "Lexical indexing is immediately available.",
  });

  expect(tasks).toEqual([]);
  expect(notifications).toHaveLength(1);
  await expect(memories.search(testContext.alice, { query: "immediately" })).resolves.toMatchObject(
    [{ memory: { id: created.id } }],
  );
  expect(tasks).toEqual(["query"]);

  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: provider,
  });
  await expect(maintenance.run(notifications[0])).resolves.toMatchObject({
    status: "complete",
    jobId: notifications[0],
  });
  expect(tasks).toEqual(["query", "document"]);

  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    const result = await transaction.query<{
      embedding_provider: string;
      embedding_model: string;
      embedding_revision: string;
    }>(
      `SELECT
         generation.embedding_provider,
         generation.embedding_model,
         generation.embedding_revision
       FROM memory_chunk_embeddings embedded
       JOIN embedding_generations generation ON generation.id = embedded.generation_id
       WHERE embedded.memory_id = $1`,
      [created.id],
    );
    expect(result.rows).toEqual([
      {
        embedding_provider: provider.provider,
        embedding_model: provider.model,
        embedding_revision: provider.revision,
      },
    ]);
  });
});

test("metadata-only updates do not send a Queue wake-up without a new job", async () => {
  const testContext = await createMemoryTestContext();
  const notifications: string[] = [];
  const provider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, {
    embeddingProvider: provider,
    maintenanceNotifier: { notify: ({ jobId }) => notifications.push(jobId) },
  });
  const created = await memories.remember(testContext.alice, { content: "Already embedded." });
  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: provider,
  });
  await expect(maintenance.run(notifications[0])).resolves.toMatchObject({ status: "complete" });

  await memories.update(testContext.alice, created.id, { metadata: { reviewed: true } });

  expect(notifications).toHaveLength(1);
});

test("failed providers release the lease with exponential retry state", async () => {
  const testContext = await createMemoryTestContext();
  const notifications: string[] = [];
  const provider = fixtureProvider(async () => {
    throw new Error("secret upstream response");
  });
  const memories = createMemoryModule(testContext.database, {
    embeddingProvider: provider,
    maintenanceNotifier: { notify: ({ jobId }) => notifications.push(jobId) },
  });
  await memories.remember(testContext.alice, { content: "Retry this embedding." });

  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: provider,
  });
  await expect(maintenance.run(notifications[0])).resolves.toEqual({
    status: "retry",
    jobId: notifications[0],
    retryAfterSeconds: 30,
  });

  const job = await testContext.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{
      status: string;
      attempt_count: number;
      last_error: string;
      lease_token: string | null;
    }>("SELECT status, attempt_count, last_error, lease_token FROM memory_embedding_jobs");
    return result.rows[0];
  });
  expect(job).toMatchObject({
    status: "pending",
    attempt_count: 1,
    last_error: "Embedding provider request failed",
    lease_token: null,
  });
  expect(job.last_error).not.toContain("secret upstream response");
});

test("dead jobs stay dead until the Memory or active embedding space changes", async () => {
  const testContext = await createMemoryTestContext();
  const provider = fixtureProvider(async () => {
    throw new Error("still unavailable");
  });
  const memories = createMemoryModule(testContext.database, { embeddingProvider: provider });
  await memories.remember(testContext.alice, { content: "Do not retry forever." });
  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.query("UPDATE memory_embedding_jobs SET max_attempts = 1");
  });

  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: provider,
  });
  await expect(maintenance.run()).resolves.toMatchObject({ status: "dead" });
  await expect(maintenance.seedStale()).resolves.toEqual([]);
  await expect(maintenance.run()).resolves.toMatchObject({ status: "idle" });
});

test("deployment sweeps prune expired terminal job history", async () => {
  const testContext = await createMemoryTestContext();
  const provider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, { embeddingProvider: provider });
  await memories.remember(testContext.alice, { content: "Prune completed history." });
  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: provider,
  });
  await expect(maintenance.run()).resolves.toMatchObject({ status: "complete" });
  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      "UPDATE memory_embedding_jobs SET completed_at = now() - interval '8 days'",
    );
  });

  await expect(maintenance.seedStale()).resolves.toEqual([]);

  const jobs = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query("SELECT id FROM memory_embedding_jobs"),
  );
  expect(jobs.rows).toEqual([]);
});

test("stale jobs cannot write chunks after a Memory version changes", async () => {
  const testContext = await createMemoryTestContext();
  const notifications: string[] = [];
  const provider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, {
    embeddingProvider: provider,
    maintenanceNotifier: { notify: ({ jobId }) => notifications.push(jobId) },
  });
  const created = await memories.remember(testContext.alice, { content: "First version." });
  await memories.update(testContext.alice, created.id, { content: "Second version." });

  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: provider,
  });
  await expect(maintenance.run(notifications[0])).resolves.toEqual({
    status: "idle",
    jobId: notifications[0],
  });
  await expect(maintenance.run(notifications[1])).resolves.toMatchObject({ status: "complete" });

  const statuses = await testContext.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ memory_version: number; status: string }>(
      `SELECT memory_version, status
       FROM memory_embedding_jobs
       ORDER BY memory_version`,
    );
    return result.rows;
  });
  expect(statuses).toEqual([
    { memory_version: 1, status: "cancelled" },
    { memory_version: 2, status: "succeeded" },
  ]);
});

test("maintenance role cannot mutate private chunks without the claimed lease context", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const created = await memories.remember(testContext.alice, {
    content: "Private RLS evidence.",
    scope: "private",
  });

  await testContext.maintenanceDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string }>(
      `UPDATE memory_chunks
       SET updated_at = now()
       WHERE memory_id = $1
       RETURNING id`,
      [created.id],
    );
    expect(result.rows).toEqual([]);
  });

  await testContext.maintenanceDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string }>(
      "DELETE FROM memory_chunks WHERE memory_id = $1 RETURNING id",
      [created.id],
    );
    expect(result.rows).toEqual([]);
  });

  await expect(
    testContext.maintenanceDatabase.transaction((transaction) =>
      transaction.query(
        `INSERT INTO memory_chunks (id, workspace_id, memory_id, ordinal, content)
         VALUES ($1, $2, $3, 1, 'Unauthorized maintenance content')`,
        [crypto.randomUUID(), testContext.alice.workspaceId, created.id],
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
});

test("request actors cannot inspect jobs and deleting a Memory cascades its job", async () => {
  const testContext = await createMemoryTestContext();
  const provider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, { embeddingProvider: provider });
  const created = await memories.remember(testContext.alice, { content: "Delete this job too." });

  await expect(
    testContext.database.transaction(async (transaction) => {
      await installActorContext(transaction, testContext.alice);
      await transaction.query("SELECT id FROM memory_embedding_jobs");
    }),
  ).rejects.toMatchObject({ code: "42501" });

  await expect(memories.forget(testContext.alice, created.id)).resolves.toBe(true);
  const jobs = await testContext.adminDatabase.transaction(async (transaction) =>
    transaction.query("SELECT id FROM memory_embedding_jobs"),
  );
  expect(jobs.rows).toEqual([]);
});

test("provider identity changes deterministically seed a replacement job", async () => {
  const testContext = await createMemoryTestContext();
  const firstProvider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, { embeddingProvider: firstProvider });
  await memories.remember(testContext.alice, { content: "Reindex when the model changes." });
  const firstMaintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: firstProvider,
  });
  await expect(firstMaintenance.run()).resolves.toMatchObject({ status: "complete" });

  const replacementProvider = {
    ...firstProvider,
    model: "fixture-embedding-v2",
    revision: "fixture-v2",
  };
  const replacementMaintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: replacementProvider,
  });
  const seeded = await replacementMaintenance.seedStale();

  expect(seeded).toHaveLength(1);
  await expect(replacementMaintenance.run(seeded[0])).resolves.toMatchObject({
    status: "complete",
  });
});

test("embedding revisions build beside the active generation and cut over atomically", async () => {
  const testContext = await createMemoryTestContext();
  const firstProvider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, { embeddingProvider: firstProvider });
  const content = "0. Ada founded Acme.\n1. Grace acquired Acme.\n2. Lin leads Acme.";
  const created = await memories.remember(testContext.alice, { content, scope: "private" });
  const firstMaintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: firstProvider,
  });
  await expect(firstMaintenance.run()).resolves.toMatchObject({ status: "complete" });

  const replacementProvider = { ...firstProvider, revision: "fixture-v2" };
  const replacementMaintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: replacementProvider,
  });
  const seeded = await replacementMaintenance.seedStale();
  expect(seeded).toHaveLength(1);
  await expect(replacementMaintenance.run(seeded[0])).resolves.toMatchObject({
    status: "complete",
  });
  await expect(replacementMaintenance.generationReport()).resolves.toMatchObject({
    status: "building",
    eligibleChunks: 3,
    embeddedChunks: 3,
    missingChunks: 0,
    pendingJobs: 0,
    deadJobs: 0,
  });

  const beforeActivation = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ embedding_revision: string; status: string }>(
      `SELECT embedding_revision, status
       FROM embedding_generations
       ORDER BY embedding_revision`,
    ),
  );
  expect(beforeActivation.rows).toEqual([
    { embedding_revision: "fixture-v1", status: "active" },
    { embedding_revision: "fixture-v2", status: "building" },
  ]);

  await expect(replacementMaintenance.activateGeneration()).resolves.toEqual(expect.any(String));

  const chunks = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ content: string; ordinal: number }>(
      `SELECT ordinal, content
       FROM memory_chunks
       WHERE memory_id = $1
       ORDER BY ordinal`,
      [created.id],
    ),
  );
  expect(chunks.rows).toEqual([
    { ordinal: 0, content: "0. Ada founded Acme." },
    { ordinal: 1, content: "1. Grace acquired Acme." },
    { ordinal: 2, content: "2. Lin leads Acme." },
  ]);

  const afterActivation = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ embedding_revision: string; status: string }>(
      `SELECT embedding_revision, status
       FROM embedding_generations
       ORDER BY embedding_revision`,
    ),
  );
  expect(afterActivation.rows).toEqual([
    { embedding_revision: "fixture-v1", status: "retiring" },
    { embedding_revision: "fixture-v2", status: "active" },
  ]);

  await expect(firstMaintenance.activateGeneration()).resolves.toEqual(expect.any(String));
  const afterRollback = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ embedding_revision: string; status: string }>(
      `SELECT embedding_revision, status
       FROM embedding_generations
       ORDER BY embedding_revision`,
    ),
  );
  expect(afterRollback.rows).toEqual([
    { embedding_revision: "fixture-v1", status: "active" },
    { embedding_revision: "fixture-v2", status: "retiring" },
  ]);

  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE embedding_generations
       SET retired_at = now() - interval '2 hours'
       WHERE status = 'retiring'`,
    ),
  );
  await expect(firstMaintenance.pruneRetiringGenerations(3_600)).resolves.toBe(1);
  const afterPrune = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ embedding_revision: string; status: string }>(
      "SELECT embedding_revision, status FROM embedding_generations",
    ),
  );
  expect(afterPrune.rows).toEqual([{ embedding_revision: "fixture-v1", status: "active" }]);
});

test("an incomplete embedding generation cannot become active", async () => {
  const testContext = await createMemoryTestContext();
  const firstProvider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, { embeddingProvider: firstProvider });
  await memories.remember(testContext.alice, { content: "Coverage must be complete." });
  const firstMaintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: firstProvider,
  });
  await expect(firstMaintenance.run()).resolves.toMatchObject({ status: "complete" });

  const replacementProvider = { ...firstProvider, revision: "fixture-v2" };
  const replacementMaintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: replacementProvider,
  });
  await expect(replacementMaintenance.seedStale()).resolves.toHaveLength(1);
  await expect(replacementMaintenance.activateGeneration()).rejects.toThrow(
    /Embedding generation is not ready/,
  );
  await expect(replacementMaintenance.generationReport()).resolves.toMatchObject({
    status: "building",
    missingChunks: 1,
    pendingJobs: 1,
  });
});
