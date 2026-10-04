import type {
  EmbeddingMaintenanceLog,
  EmbeddingProvider,
  EmbeddingTask,
  PostgresDatabase,
} from "@corespeed/lore-core";
import {
  chunkMemoryContent,
  createEmbeddingGenerationAdmin,
  createEmbeddingMaintenance,
  embeddingGenerationServing,
} from "@corespeed/lore-core";
import { expect, test } from "vitest";
import { createMemoryModule } from "../../src/modules/memories/service";
import { installActorContext } from "../../src/server/auth/actor-context";
import { createMemoryTestContext } from "../support/memory-context";

function fixtureVector(index: number): number[] {
  return Array.from({ length: 1024 }, (_, vectorIndex) => (vectorIndex === index ? 1 : 0));
}

/** A sweep with no lanes only prunes expired retiring generations. */
async function pruneRetiringGenerations(database: PostgresDatabase): Promise<number> {
  const maintenance = createEmbeddingMaintenance(database, {
    embeddingProviders: [],
    generationRetentionSeconds: 3_600,
  });
  return (await maintenance.sweep()).prunedGenerations;
}

function generationReport(database: PostgresDatabase, provider: EmbeddingProvider) {
  return createEmbeddingGenerationAdmin(database).findReport(provider);
}

function activateGeneration(database: PostgresDatabase, provider: EmbeddingProvider) {
  return createEmbeddingGenerationAdmin(database).activate(provider);
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

  const maintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
  });
  await expect(maintenance.run({ jobId: notifications[0] })).resolves.toMatchObject({
    status: "complete",
    jobId: notifications[0],
  });
  expect(tasks).toEqual(["query", "document"]);

  await testContext.database.transaction(async (transaction) => {
    installActorContext(transaction, testContext.alice);
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
  const maintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
  });
  await expect(maintenance.run({ jobId: notifications[0] })).resolves.toMatchObject({
    status: "complete",
  });

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

  const maintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
  });
  await expect(maintenance.run({ jobId: notifications[0] })).resolves.toEqual({
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

test("failed runs log and return exact retry and dead outcomes", async () => {
  const testContext = await createMemoryTestContext();
  const notifications: string[] = [];
  const provider = fixtureProvider(async () => {
    throw new Error("still unavailable");
  });
  const memories = createMemoryModule(testContext.database, {
    embeddingProvider: provider,
    maintenanceNotifier: { notify: ({ jobId }) => notifications.push(jobId) },
  });
  await memories.remember(testContext.alice, { content: "Retry this embedding later." });
  await memories.remember(testContext.alice, {
    content: `# Exhausted\n\n${"This embedding has no attempts left. ".repeat(40)}`,
  });
  const [retryJob, deadJob] = notifications;
  if (!retryJob || !deadJob) throw new Error("Both writes must enqueue a job");
  const deadChunkCount = await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.query("UPDATE memory_embedding_jobs SET max_attempts = 1 WHERE id = $1", [
      deadJob,
    ]);
    const result = await transaction.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM memory_chunks chunk
       JOIN memory_embedding_jobs job ON job.memory_id = chunk.memory_id
       WHERE job.id = $1`,
      [deadJob],
    );
    return result.rows[0]?.count;
  });
  expect(deadChunkCount).toBeGreaterThan(1);
  const logs: EmbeddingMaintenanceLog[] = [];
  const maintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
    logger: (entry) => logs.push(entry),
  });

  await expect(maintenance.run({ jobId: retryJob })).resolves.toEqual({
    status: "retry",
    jobId: retryJob,
    retryAfterSeconds: 30,
  });
  await expect(maintenance.run({ jobId: deadJob })).resolves.toEqual({
    status: "dead",
    jobId: deadJob,
  });
  const generation = {
    embeddingProvider: "fixture",
    embeddingModel: "fixture-embedding-v1",
    embeddingRevision: "fixture-v1",
  };
  expect(logs).toEqual([
    { ...generation, event: "job_retry", jobId: retryJob, attempt: 1, chunkCount: 1 },
    { ...generation, event: "job_dead", jobId: deadJob, attempt: 1, chunkCount: deadChunkCount },
  ]);
  await testContext.close();
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

  const maintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
  });
  await expect(maintenance.run()).resolves.toMatchObject({ status: "dead" });
  expect((await maintenance.sweep()).seeded).toEqual([]);
  await expect(maintenance.run()).resolves.toMatchObject({ status: "idle" });

  await memories.update(testContext.alice, created.id, { content: "A new version may retry." });
  expect((await maintenance.sweep()).seeded).toEqual([]);
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

  const maintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
  });
  expect((await maintenance.sweep()).seeded).toEqual([]);
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
  const maintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
  });
  await expect(maintenance.run()).resolves.toMatchObject({ status: "complete" });
  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      "UPDATE memory_embedding_jobs SET completed_at = now() - interval '8 days'",
    );
  });

  expect((await maintenance.sweep()).seeded).toEqual([]);

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

  const maintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
  });
  await expect(maintenance.run({ jobId: notifications[0] })).resolves.toEqual({
    status: "idle",
    jobId: notifications[0],
  });
  await expect(maintenance.run({ jobId: notifications[1] })).resolves.toMatchObject({
    status: "complete",
  });

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

test("a claim returns only chunks missing a vector, and a job missing none skips the provider", async () => {
  const testContext = await createMemoryTestContext();
  const notifications: string[] = [];
  const embedded: string[][] = [];
  const provider = fixtureProvider(async (texts) => {
    embedded.push(texts);
    return texts.map(() => fixtureVector(0));
  });
  const memories = createMemoryModule(testContext.database, {
    embeddingProvider: provider,
    maintenanceNotifier: { notify: ({ jobId }) => notifications.push(jobId) },
  });
  const content = ["First", "Second", "Third"]
    .map((word) => `${word} paragraph. `.repeat(70).trim())
    .join("\n\n");
  const chunks = chunkMemoryContent(content);
  expect(chunks.length).toBeGreaterThan(2);
  const created = await memories.remember(testContext.alice, { content });
  const jobId = notifications[0];
  if (!jobId) throw new Error("Expected an embedding job");
  const maintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
  });
  await expect(maintenance.run({ jobId })).resolves.toMatchObject({ status: "complete" });
  expect(embedded).toEqual([chunks]);

  const admin = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    testContext.adminDatabase.transaction(
      async (transaction) => (await transaction.query<T>(sql, params)).rows,
    );
  // Re-arming the succeeded job stands in for any later job of the same version.
  const rearm = () =>
    admin(
      `UPDATE memory_embedding_jobs
       SET status = 'pending', attempt_count = 0, completed_at = NULL,
           available_at = now(), updated_at = now()
       WHERE id = $1`,
      [jobId],
    );
  const state = () =>
    admin<{ status: string; vectors: number }>(
      `SELECT job.status,
              (SELECT count(*)::integer FROM memory_chunk_embeddings embedded
               WHERE embedded.memory_id = job.memory_id) AS vectors
       FROM memory_embedding_jobs job WHERE job.id = $1`,
      [jobId],
    );

  await admin(
    `DELETE FROM memory_chunk_embeddings embedded
     USING memory_chunks chunk
     WHERE chunk.id = embedded.chunk_id AND chunk.memory_id = $1 AND chunk.ordinal = 1`,
    [created.id],
  );
  await rearm();
  await expect(maintenance.run({ jobId })).resolves.toMatchObject({ status: "complete" });
  expect(embedded.at(-1)).toEqual([chunks[1]]);
  await expect(state()).resolves.toEqual([{ status: "succeeded", vectors: chunks.length }]);

  await rearm();
  await expect(maintenance.run({ jobId })).resolves.toEqual({ status: "complete", jobId });
  expect(embedded).toHaveLength(2);
  await expect(state()).resolves.toEqual([{ status: "succeeded", vectors: chunks.length }]);
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

  const maintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
  });
  await expect(maintenance.run({ jobId: notifications[0] })).resolves.toEqual({
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

test("maintenance role can never mutate canonical chunks", async () => {
  const testContext = await createMemoryTestContext();
  const provider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, { embeddingProvider: provider });
  const created = await memories.remember(testContext.alice, {
    content: "Private RLS evidence.",
    scope: "private",
  });

  // Maintenance writes generation-scoped vectors only. Even inside a valid
  // claimed lease the role holds no UPDATE privilege on canonical chunk rows.
  await expect(
    testContext.maintenanceDatabase.transaction((transaction) =>
      transaction.query("UPDATE memory_chunks SET updated_at = now() WHERE memory_id = $1", [
        created.id,
      ]),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  const claimedLease = await testContext.adminDatabase.transaction(async (transaction) => {
    const lease = crypto.randomUUID();
    const result = await transaction.query<{ id: string }>(
      `UPDATE memory_embedding_jobs
       SET status = 'processing', attempt_count = 1, lease_token = $1, leased_at = now()
       WHERE memory_id = $2
       RETURNING id`,
      [lease, created.id],
    );
    return { id: result.rows[0]?.id ?? "", lease };
  });
  await expect(
    testContext.maintenanceDatabase.transaction(async (transaction) => {
      await transaction.query(
        `SELECT set_config('lore.maintenance_job_id', $1, true),
                set_config('lore.maintenance_lease_token', $2, true)`,
        [claimedLease.id, claimedLease.lease],
      );
      await transaction.query(
        "UPDATE memory_chunks SET content = 'Rewritten by maintenance' WHERE memory_id = $1",
        [created.id],
      );
    }),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(memories.retrieve(testContext.alice, created.id)).resolves.toMatchObject({
    content: "Private RLS evidence.",
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
      installActorContext(transaction, testContext.alice);
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
  const firstMaintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [firstProvider],
  });
  await expect(firstMaintenance.run()).resolves.toMatchObject({ status: "complete" });

  const replacementProvider = {
    ...firstProvider,
    model: "fixture-embedding-v2",
    revision: "fixture-v2",
  };
  const replacementMaintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [replacementProvider],
  });
  const { seeded } = await replacementMaintenance.sweep();

  expect(seeded).toHaveLength(1);
  await expect(replacementMaintenance.run({ jobId: seeded[0] })).resolves.toMatchObject({
    status: "complete",
  });
});

test("embedding revisions build beside the active generation and cut over atomically", async () => {
  const testContext = await createMemoryTestContext();
  const firstProvider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, { embeddingProvider: firstProvider });
  const content = "Ada founded Acme. Grace acquired Acme. Lin leads Acme.";
  const created = await memories.remember(testContext.alice, { content, scope: "private" });
  const firstMaintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [firstProvider],
  });
  await expect(firstMaintenance.run()).resolves.toMatchObject({ status: "complete" });

  const replacementProvider = { ...firstProvider, revision: "fixture-v2" };
  const replacementMaintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [replacementProvider],
  });
  const { seeded } = await replacementMaintenance.sweep();
  expect(seeded).toHaveLength(1);
  await expect(replacementMaintenance.run({ jobId: seeded[0] })).resolves.toMatchObject({
    status: "complete",
  });
  await expect(
    generationReport(testContext.maintenanceDatabase, replacementProvider),
  ).resolves.toMatchObject({
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

  await expect(
    activateGeneration(testContext.maintenanceDatabase, replacementProvider),
  ).resolves.toEqual(expect.any(String));

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

  await expect(activateGeneration(testContext.maintenanceDatabase, firstProvider)).resolves.toEqual(
    expect.any(String),
  );
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
  await expect(pruneRetiringGenerations(testContext.maintenanceDatabase)).resolves.toBe(0);

  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE memory_embedding_jobs job
       SET leased_at = now() - interval '2 hours', updated_at = now()
       FROM embedding_generations generation
       WHERE generation.id = job.generation_id
         AND generation.status = 'retiring'`,
    ),
  );
  await expect(pruneRetiringGenerations(testContext.maintenanceDatabase)).resolves.toBe(1);
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

  const servingMaintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [servingProvider],
  });
  await expect(servingMaintenance.run({ jobId: notifications.shift() })).resolves.toMatchObject({
    status: "complete",
  });

  const buildingProvider = { ...servingProvider, revision: "fixture-v2" };
  const buildingMaintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [buildingProvider],
  });
  expect((await buildingMaintenance.sweep()).seeded).toHaveLength(1);

  const rollout = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [servingProvider, buildingProvider],
  });
  const buildingJobHint = (await buildingMaintenance.pending())[0];
  expect(buildingJobHint).toEqual({ jobId: expect.any(String) });
  await expect(rollout.run(buildingJobHint)).resolves.toMatchObject({
    status: "complete",
    jobId: buildingJobHint?.jobId,
  });

  await memories.remember(testContext.alice, { content: "Written while v2 is building." });
  const servingJobHint = notifications.shift();
  expect(servingJobHint).toEqual(expect.any(String));
  await expect(rollout.run({ jobId: servingJobHint })).resolves.toMatchObject({
    status: "complete",
    jobId: servingJobHint,
  });

  await memories.remember(testContext.alice, { content: "Lost Queue hint must be swept." });
  const lostServingHint = notifications.shift();
  expect(lostServingHint).toEqual(expect.any(String));
  await rollout.sweep();
  await expect(rollout.pending(100)).resolves.toEqual(
    expect.arrayContaining([{ jobId: lostServingHint }]),
  );

  for (;;) {
    const result = await rollout.run();
    if (result.status === "idle") break;
  }

  await expect(
    generationReport(testContext.maintenanceDatabase, servingProvider),
  ).resolves.toMatchObject({
    status: "active",
    missingChunks: 0,
    pendingJobs: 0,
  });
  await expect(
    generationReport(testContext.maintenanceDatabase, buildingProvider),
  ).resolves.toMatchObject({
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
  const firstMaintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [firstProvider],
  });
  await expect(firstMaintenance.run()).resolves.toMatchObject({ status: "complete" });

  const replacementProvider = { ...firstProvider, revision: "fixture-v2" };
  const replacementMaintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [replacementProvider],
  });
  expect((await replacementMaintenance.sweep()).seeded).toHaveLength(1);
  await expect(
    activateGeneration(testContext.maintenanceDatabase, replacementProvider),
  ).rejects.toThrow(/Embedding generation is not ready/);
  await expect(
    generationReport(testContext.maintenanceDatabase, replacementProvider),
  ).resolves.toMatchObject({
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

  const firstMaintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [firstProvider],
  });
  await expect(firstMaintenance.run()).resolves.toMatchObject({ status: "complete" });

  const replacementProvider = { ...firstProvider, revision: "fixture-v2" };
  const replacementMaintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [replacementProvider],
  });
  expect((await replacementMaintenance.sweep()).seeded).toHaveLength(1);
  await expect(replacementMaintenance.run()).resolves.toMatchObject({ status: "complete" });
  await expect(
    activateGeneration(testContext.maintenanceDatabase, replacementProvider),
  ).resolves.toEqual(expect.any(String));

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

  await expect(pruneRetiringGenerations(testContext.maintenanceDatabase)).resolves.toBe(1);
  await expect(firstMaintenance.run({ jobId: retiredJob.rows[0].id })).resolves.toEqual({
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

function pausedProvider(pausedVector: number, resumedVector: number) {
  let release: () => void = () => undefined;
  let signalStarted: () => void = () => undefined;
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let calls = 0;
  const provider = fixtureProvider(async (texts) => {
    calls += 1;
    if (calls === 1) {
      signalStarted();
      await resumed;
      return texts.map(() => fixtureVector(pausedVector));
    }
    return texts.map(() => fixtureVector(resumedVector));
  });
  return { provider, release: () => release(), started };
}

test("a run whose lease is reclaimed mid-embed writes nothing and reports lost", async () => {
  const testContext = await createMemoryTestContext();
  const { provider, release, started } = pausedProvider(1, 0);
  const memories = createMemoryModule(testContext.database, { embeddingProvider: provider });
  const created = await memories.remember(testContext.alice, {
    content: "The provider stalls long enough for the lease to expire.",
  });
  const logs: string[] = [];
  const stalled = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
    logger: (entry) => logs.push(entry.event),
  });
  const replacement = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
  });

  const stalledRun = stalled.run();
  await started;
  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query("UPDATE memory_embedding_jobs SET leased_at = now() - interval '1 hour'"),
  );
  const completed = await replacement.run();
  expect(completed).toMatchObject({ status: "complete" });
  release();

  await expect(stalledRun).resolves.toEqual({ status: "lost", jobId: completed.jobId });
  expect(logs).toEqual(["job_lost"]);
  const jobs = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ attempt_count: number; last_error: string | null; status: string }>(
      "SELECT status::text, attempt_count, last_error FROM memory_embedding_jobs",
    ),
  );
  expect(jobs.rows).toEqual([{ status: "succeeded", attempt_count: 2, last_error: null }]);
  // Only the replacement's vectors exist: the stalled run's axis-1 vector was fenced.
  const vectors = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ paused_axis: number; resumed_axis: number }>(
      `SELECT (embedding::real[])[2] AS paused_axis, (embedding::real[])[1] AS resumed_axis
       FROM memory_chunk_embeddings
       WHERE memory_id = $1`,
      [created.id],
    ),
  );
  expect(vectors.rows).toEqual([{ paused_axis: 0, resumed_axis: 1 }]);
});

test("a run whose Memory is deleted mid-embed reports lost instead of failing", async () => {
  const testContext = await createMemoryTestContext();
  const { provider, release, started } = pausedProvider(0, 0);
  const memories = createMemoryModule(testContext.database, { embeddingProvider: provider });
  const created = await memories.remember(testContext.alice, { content: "Forgotten mid-embed." });
  const maintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
  });

  const run = maintenance.run();
  await started;
  await expect(memories.forget(testContext.alice, created.id)).resolves.toBe(true);
  release();

  await expect(run).resolves.toMatchObject({ status: "lost" });
  const leftovers = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query(
      `SELECT 1 FROM memory_embedding_jobs
       UNION ALL SELECT 1 FROM memory_chunk_embeddings`,
    ),
  );
  expect(leftovers.rows).toEqual([]);
});

test("a lane leases jobs for its provider's request deadline, or the default window without one", async () => {
  const testContext = await createMemoryTestContext();
  const provider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, { embeddingProvider: provider });
  const created = await memories.remember(testContext.alice, { content: "A stalled claim." });
  // Make the current job look claimed by a run that started this long ago.
  const leasedSecondsAgo = (seconds: number) =>
    testContext.adminDatabase.transaction((transaction) =>
      transaction.query(
        `UPDATE memory_embedding_jobs
         SET status = 'processing', attempt_count = 1, lease_token = gen_random_uuid(),
             leased_at = now() - make_interval(secs => $1::double precision), updated_at = now()
         WHERE status IN ('pending', 'processing')`,
        [seconds],
      ),
    );
  // No deadline (Ollama): 420 seconds. A 10-second deadline: 90 seconds.
  const withoutDeadline = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
  });
  const withDeadline = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [{ ...provider, requestTimeoutMs: 10_000 }],
  });

  await leasedSecondsAgo(80);
  await expect(withDeadline.run()).resolves.toEqual({ status: "idle" });
  await leasedSecondsAgo(400);
  await expect(withoutDeadline.run()).resolves.toEqual({ status: "idle" });
  await leasedSecondsAgo(100);
  await expect(withDeadline.run()).resolves.toMatchObject({ status: "complete" });

  await memories.update(testContext.alice, created.id, { content: "Another stalled claim." });
  await leasedSecondsAgo(430);
  await expect(withoutDeadline.run()).resolves.toMatchObject({ status: "complete" });
});

test("a malformed queue message is invalid and claims nothing", async () => {
  const testContext = await createMemoryTestContext();
  const notifications: string[] = [];
  const provider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, {
    embeddingProvider: provider,
    maintenanceNotifier: { notify: ({ jobId }) => notifications.push(jobId) },
  });
  await memories.remember(testContext.alice, { content: "Only a well-formed hint runs this." });
  const maintenance = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [provider],
  });

  // A queue message whose body is undefined is malformed too; only a call with no
  // message at all claims any due job.
  for (const message of [
    undefined,
    null,
    "job",
    7,
    [],
    {},
    { jobId: 7 },
    { id: notifications[0] },
  ]) {
    await expect(maintenance.run(message)).resolves.toEqual({ status: "invalid" });
  }
  const job = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ attempt_count: number; status: string }>(
      "SELECT status::text, attempt_count FROM memory_embedding_jobs",
    ),
  );
  expect(job.rows).toEqual([{ status: "pending", attempt_count: 0 }]);
  await expect(maintenance.pending()).resolves.toEqual([{ jobId: notifications[0] }]);
  await expect(maintenance.run({ jobId: notifications[0] })).resolves.toMatchObject({
    status: "complete",
    jobId: notifications[0],
  });

  const disabled = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [],
  });
  expect(disabled.enabled).toBe(false);
  await expect(disabled.run({ jobId: notifications[0] })).resolves.toEqual({
    status: "idle",
    jobId: notifications[0],
  });
  await expect(disabled.pending()).resolves.toEqual([]);
});

test("unnamed claims rotate across generations so a rollout cannot starve serving", async () => {
  const testContext = await createMemoryTestContext();
  const embedded: string[] = [];
  const servingProvider = fixtureProvider(async (texts) => {
    embedded.push("serving");
    return texts.map(() => fixtureVector(0));
  });
  const buildingProvider = {
    ...fixtureProvider(async (texts) => {
      embedded.push("building");
      return texts.map(() => fixtureVector(1));
    }),
    revision: "fixture-v2",
  };
  const memories = createMemoryModule(testContext.database, { embeddingProvider: servingProvider });
  await memories.remember(testContext.alice, { content: "First serving job." });
  await memories.remember(testContext.alice, { content: "Second serving job." });
  const building = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [buildingProvider],
  });
  expect((await building.sweep()).seeded).toHaveLength(2);

  const rollout = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [servingProvider, buildingProvider],
  });
  for (let round = 0; round < 4; round += 1) {
    await expect(rollout.run()).resolves.toMatchObject({ status: "complete" });
  }
  expect(embedded).toEqual(["serving", "building", "serving", "building"]);
  await expect(rollout.run()).resolves.toEqual({ status: "idle" });
});

test("a sweep prunes expired retiring generations, seeds missing vectors, and reports each lane", async () => {
  const testContext = await createMemoryTestContext();
  const firstProvider = fixtureProvider(async (texts) => texts.map(() => fixtureVector(0)));
  const memories = createMemoryModule(testContext.database, { embeddingProvider: firstProvider });
  await memories.remember(testContext.alice, { content: "Swept into a new embedding space." });
  const first = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [firstProvider],
  });
  await expect(first.run()).resolves.toMatchObject({ status: "complete" });

  const replacementProvider = { ...firstProvider, revision: "fixture-v2" };
  const rollout = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [firstProvider, replacementProvider],
    generationRetentionSeconds: 3_600,
  });
  const building = await rollout.sweep();
  expect(building).toEqual({
    prunedGenerations: 0,
    seeded: [expect.any(String)],
    generations: [
      expect.objectContaining({ status: "active", missingChunks: 0, pendingJobs: 0 }),
      expect.objectContaining({ status: "building", missingChunks: 1, pendingJobs: 1 }),
    ],
  });
  await expect(rollout.run({ jobId: building.seeded[0] })).resolves.toMatchObject({
    status: "complete",
  });
  await activateGeneration(testContext.maintenanceDatabase, replacementProvider);
  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE embedding_generations SET retired_at = now() - interval '2 hours'
       WHERE status = 'retiring'`,
    ),
  );

  const replacement = createEmbeddingMaintenance(testContext.maintenanceDatabase, {
    embeddingProviders: [replacementProvider],
    generationRetentionSeconds: 3_600,
  });
  await expect(replacement.sweep()).resolves.toEqual({
    prunedGenerations: 1,
    seeded: [],
    generations: [expect.objectContaining({ status: "active", missingChunks: 0 })],
  });
});

test("only an active or retiring generation of the exact identity is serving", async () => {
  const testContext = await createMemoryTestContext();
  const identity = {
    provider: "fixture",
    model: "fixture-embedding-v1",
    dimensions: 1024,
    revision: "fixture-v1",
  };
  const serving = (candidate: typeof identity) =>
    testContext.database.transaction((transaction) =>
      embeddingGenerationServing(transaction, candidate),
    );
  const setStatus = (status: string) =>
    testContext.adminDatabase.transaction((transaction) =>
      transaction.query(
        `UPDATE embedding_generations
         SET status = $1::embedding_generation_status,
             activated_at = CASE WHEN $1 = 'building' THEN NULL ELSE now() END,
             retired_at = CASE WHEN $1 = 'retiring' THEN now() END`,
        [status],
      ),
    );

  await expect(serving(identity)).resolves.toBe(false);
  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query("SELECT lore.ensure_embedding_generation($1, $2, $3, $4)", [
      identity.provider,
      identity.model,
      identity.dimensions,
      identity.revision,
    ]),
  );
  for (const [status, expected] of [
    ["active", true],
    ["retiring", true],
    ["building", false],
  ] as const) {
    await setStatus(status);
    await expect(serving(identity), status).resolves.toBe(expected);
  }
  await setStatus("active");
  await expect(serving({ ...identity, dimensions: 1536 })).resolves.toBe(false);
  await expect(serving({ ...identity, revision: "fixture-v2" })).resolves.toBe(false);
  await expect(serving({ ...identity, model: "fixture-embedding-v2" })).resolves.toBe(false);
  await expect(serving({ ...identity, provider: "other" })).resolves.toBe(false);
});
