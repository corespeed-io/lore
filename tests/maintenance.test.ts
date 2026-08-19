import {
  createMemoryMaintenanceCoordinator,
  createMemoryMaintenanceModule,
  createMemoryModule,
  type EmbeddingTask,
  installActorContext,
  pruneRetiringEmbeddingGenerations,
} from "@corespeed/lore-core";
import { expect, test } from "vitest";
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
  const created = await memories.remember(testContext.alice, { content: "Do not retry forever." });
  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.query("UPDATE memory_embedding_jobs SET max_attempts = 1");
  });

  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: provider,
  });
  await expect(maintenance.run()).resolves.toMatchObject({ status: "dead" });
  await expect(maintenance.seedStale()).resolves.toEqual([]);
  await expect(maintenance.run()).resolves.toMatchObject({ status: "idle" });

  await memories.update(testContext.alice, created.id, { content: "A new version may retry." });
  await expect(maintenance.seedStale()).resolves.toEqual([]);
  const statuses = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ memory_version: number; status: string }>(
      `SELECT memory_version, status::text
       FROM memory_embedding_jobs
       ORDER BY memory_version`,
    ),
  );
  expect(statuses.rows).toEqual([
    { memory_version: 1, status: "cancelled" },
    { memory_version: 2, status: "pending" },
  ]);
});

test("deployment sweeps bound and retire exhausted processing leases", async () => {
  const testContext = await createMemoryTestContext();
  const provider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, { embeddingProvider: provider });
  await memories.remember(testContext.alice, { content: "An abandoned final attempt." });
  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE memory_embedding_jobs
       SET status = 'processing', attempt_count = max_attempts,
           lease_token = gen_random_uuid(), leased_at = now() - interval '2 hours'`,
    ),
  );

  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: provider,
  });
  await expect(maintenance.seedStale(1)).resolves.toEqual([]);
  const job = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ status: string }>("SELECT status::text FROM memory_embedding_jobs"),
  );
  expect(job.rows).toEqual([{ status: "dead" }]);
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

test("a requested embedding hint cleans only its own stale job", async () => {
  const testContext = await createMemoryTestContext();
  const notifications: string[] = [];
  const provider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, {
    embeddingProvider: provider,
    maintenanceNotifier: { notify: ({ jobId }) => notifications.push(jobId) },
  });
  const first = await memories.remember(testContext.alice, { content: "First old version." });
  const second = await memories.remember(testContext.alice, { content: "Second old version." });
  await memories.update(testContext.alice, first.id, { content: "First new version." });
  await memories.update(testContext.alice, second.id, { content: "Second new version." });

  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: provider,
  });
  await expect(maintenance.run(notifications[0])).resolves.toEqual({
    status: "idle",
    jobId: notifications[0],
  });

  const oldStatuses = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ id: string; status: string }>(
      `SELECT id, status::text
       FROM memory_embedding_jobs
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [[notifications[0], notifications[1]]],
    ),
  );
  expect(oldStatuses.rows).toEqual(
    [
      { id: notifications[0], status: "cancelled" },
      { id: notifications[1], status: "pending" },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  );
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

  await expect(
    testContext.maintenanceDatabase.transaction((transaction) =>
      transaction.query("DELETE FROM memory_chunks WHERE memory_id = $1 RETURNING id", [
        created.id,
      ]),
    ),
  ).rejects.toMatchObject({ code: "42501" });

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
  const content = "Ada founded Acme. Grace acquired Acme. Lin leads Acme.";
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
    eligibleChunks: 1,
    embeddedChunks: 1,
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
  expect(chunks.rows).toEqual([{ ordinal: 0, content }]);

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

  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE memory_embedding_jobs job
       SET status = 'processing', lease_token = gen_random_uuid(), leased_at = now(),
           completed_at = NULL, updated_at = now()
       FROM embedding_generations generation
       WHERE generation.id = job.generation_id
         AND generation.status = 'retiring'`,
    ),
  );
  await expect(
    pruneRetiringEmbeddingGenerations(testContext.maintenanceDatabase, 3_600),
  ).resolves.toBe(0);

  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE memory_embedding_jobs job
       SET leased_at = now() - interval '2 hours', updated_at = now()
       FROM embedding_generations generation
       WHERE generation.id = job.generation_id
         AND generation.status = 'retiring'`,
    ),
  );
  await expect(
    pruneRetiringEmbeddingGenerations(testContext.maintenanceDatabase, 3_600),
  ).resolves.toBe(1);
  const afterPrune = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ embedding_revision: string; status: string }>(
      "SELECT embedding_revision, status FROM embedding_generations",
    ),
  );
  expect(afterPrune.rows).toEqual([{ embedding_revision: "fixture-v1", status: "active" }]);
});

test("rollout maintenance drains serving queue hints and both generations through its backstop", async () => {
  const testContext = await createMemoryTestContext();
  const servingProvider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const notifications: string[] = [];
  const memories = createMemoryModule(testContext.database, {
    embeddingProvider: servingProvider,
    maintenanceNotifier: { notify: ({ jobId }) => notifications.push(jobId) },
  });
  await memories.remember(testContext.alice, { content: "Existing active-generation Memory." });

  const servingMaintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: servingProvider,
  });
  await expect(servingMaintenance.run(notifications.shift())).resolves.toMatchObject({
    status: "complete",
  });

  const buildingProvider = { ...servingProvider, revision: "fixture-v2" };
  const buildingMaintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: buildingProvider,
  });
  await expect(buildingMaintenance.seedStale()).resolves.toHaveLength(1);

  const rollout = createMemoryMaintenanceCoordinator([servingMaintenance, buildingMaintenance]);
  const buildingJobHint = (await buildingMaintenance.pending())[0];
  expect(buildingJobHint).toEqual(expect.any(String));
  await expect(rollout.run(buildingJobHint)).resolves.toMatchObject({
    status: "complete",
    jobId: buildingJobHint,
  });

  await memories.remember(testContext.alice, { content: "Written while v2 is building." });
  const servingJobHint = notifications.shift();
  expect(servingJobHint).toEqual(expect.any(String));
  await expect(rollout.run(servingJobHint)).resolves.toMatchObject({
    status: "complete",
    jobId: servingJobHint,
  });

  await memories.remember(testContext.alice, { content: "Lost Queue hint must be swept." });
  const lostServingHint = notifications.shift();
  expect(lostServingHint).toEqual(expect.any(String));
  await rollout.seedStale(100);
  await expect(rollout.pending(100)).resolves.toEqual(expect.arrayContaining([lostServingHint]));

  for (;;) {
    const result = await rollout.run();
    if (result.status === "idle") break;
  }

  await expect(servingMaintenance.generationReport()).resolves.toMatchObject({
    status: "active",
    missingChunks: 0,
    pendingJobs: 0,
  });
  await expect(buildingMaintenance.generationReport()).resolves.toMatchObject({
    status: "building",
    missingChunks: 0,
    pendingJobs: 0,
  });
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

test("expired retiring generations cancel abandoned pending jobs before pruning", async () => {
  const testContext = await createMemoryTestContext();
  const firstProvider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, { embeddingProvider: firstProvider });
  await memories.remember(testContext.alice, { content: "Retire the old embedding space." });

  const firstMaintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: firstProvider,
  });
  await expect(firstMaintenance.run()).resolves.toMatchObject({ status: "complete" });

  const replacementProvider = { ...firstProvider, revision: "fixture-v2" };
  const replacementMaintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: replacementProvider,
  });
  await expect(replacementMaintenance.seedStale()).resolves.toHaveLength(1);
  await expect(replacementMaintenance.run()).resolves.toMatchObject({ status: "complete" });
  await expect(replacementMaintenance.activateGeneration()).resolves.toEqual(expect.any(String));

  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      `UPDATE embedding_generations generation
       SET retired_at = now() - interval '2 hours'
       WHERE generation.status = 'retiring'`,
    );
    await transaction.query(
      `UPDATE memory_embedding_jobs job
       SET status = 'pending', lease_token = NULL, leased_at = NULL,
           completed_at = NULL, updated_at = now()
       FROM embedding_generations generation
       WHERE generation.id = job.generation_id
         AND generation.status = 'retiring'`,
    );
  });

  const retiredJob = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ id: string }>(
      `SELECT job.id
       FROM memory_embedding_jobs job
       JOIN embedding_generations generation ON generation.id = job.generation_id
       WHERE generation.status = 'retiring'`,
    ),
  );
  expect(retiredJob.rows).toHaveLength(1);

  await expect(
    pruneRetiringEmbeddingGenerations(testContext.maintenanceDatabase, 3_600),
  ).resolves.toBe(1);
  await expect(firstMaintenance.run(retiredJob.rows[0].id)).resolves.toEqual({
    status: "idle",
    jobId: retiredJob.rows[0].id,
  });
  const retiredState = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ generation_count: string; job_count: string }>(
      `SELECT
         count(DISTINCT generation.id)::text AS generation_count,
         count(job.id)::text AS job_count
       FROM embedding_generations generation
       LEFT JOIN memory_embedding_jobs job ON job.generation_id = generation.id
       WHERE generation.embedding_revision = 'fixture-v1'`,
    ),
  );
  expect(retiredState.rows).toEqual([{ generation_count: "0", job_count: "0" }]);
});
