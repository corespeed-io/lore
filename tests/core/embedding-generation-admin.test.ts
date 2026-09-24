import { createMemoryMaintenanceModule } from "@corespeed/lore-core";
import { expect, test } from "vitest";
import { createMemoryModule } from "../../src/modules/memories/service";
import type { MemoryTestContext } from "../support/memory-context";
import { createMemoryTestContext } from "../support/memory-context";

// Operator paths behind `db:embedding:report` and `db:embedding:requeue-dead`.

function unavailableProvider(revision = "fixture-v1") {
  return {
    provider: "fixture",
    model: "fixture-embedding-v1",
    dimensions: 1024 as const,
    revision,
    async embed(): Promise<number[][]> {
      throw new Error("provider unavailable");
    },
  };
}

async function jobStates(testContext: MemoryTestContext) {
  const result = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{
      memory_id: string;
      memory_version: number;
      status: string;
      attempt_count: number;
      last_error: string | null;
      lease_token: string | null;
    }>(
      `SELECT memory_id, memory_version, status::text, attempt_count, last_error, lease_token
       FROM memory_embedding_jobs
       ORDER BY memory_id, memory_version`,
    ),
  );
  return result.rows;
}

function requeueDead(testContext: MemoryTestContext, generationId: string, apply: boolean) {
  return testContext.maintenanceDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ count: string | number }>(
      "SELECT lore.requeue_dead_memory_embedding_jobs($1, $2) AS count",
      [generationId, apply],
    );
    return Number(result.rows[0]?.count);
  });
}

/** Two Memories whose only embedding jobs are dead, then one edited to a new version. */
async function deadJobsWithOneStale() {
  const testContext = await createMemoryTestContext();
  const provider = unavailableProvider();
  const memories = createMemoryModule(testContext.database, { embeddingProvider: provider });
  const current = await memories.remember(testContext.alice, { content: "Still current." });
  const edited = await memories.remember(testContext.alice, { content: "About to change." });
  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query("UPDATE memory_embedding_jobs SET max_attempts = 1"),
  );
  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: provider,
  });
  await expect(maintenance.run()).resolves.toMatchObject({ status: "dead" });
  await expect(maintenance.run()).resolves.toMatchObject({ status: "dead" });
  // The edit enqueues a version-2 job; the version-1 job stays dead until a sweep.
  await memories.update(testContext.alice, edited.id, { content: "Changed after it died." });
  const report = await maintenance.generationReport();
  return { current, edited, maintenance, report, testContext };
}

test("requeueing dead embedding jobs counts first and re-arms only jobs of unchanged Memories", async () => {
  const { current, edited, report, testContext } = await deadJobsWithOneStale();
  expect(report).toMatchObject({ deadJobs: 2, pendingJobs: 1 });
  const before = await jobStates(testContext);

  // The dry run counts only the job whose Memory still matches it and writes nothing.
  await expect(requeueDead(testContext, report.id, false)).resolves.toBe(1);
  await expect(jobStates(testContext)).resolves.toEqual(before);

  await expect(requeueDead(testContext, report.id, true)).resolves.toBe(1);
  const after = await jobStates(testContext);
  expect(after.filter((job) => job.memory_id === current.id)).toEqual([
    {
      memory_id: current.id,
      memory_version: 1,
      status: "pending",
      attempt_count: 0,
      last_error: null,
      lease_token: null,
    },
  ]);
  // The stale version-1 job stays dead for the sweep to cancel; version 2 is untouched.
  expect(
    after
      .filter((job) => job.memory_id === edited.id)
      .map(({ memory_version, status }) => ({ memory_version, status })),
  ).toEqual([
    { memory_version: 1, status: "dead" },
    { memory_version: 2, status: "pending" },
  ]);
  await expect(requeueDead(testContext, report.id, false)).resolves.toBe(0);
});

test("requeueing dead embedding jobs refuses unknown generations and request actors", async () => {
  const { report, testContext } = await deadJobsWithOneStale();
  const before = await jobStates(testContext);

  await expect(requeueDead(testContext, crypto.randomUUID(), true)).rejects.toThrow(
    /is not building or active/,
  );
  // Only the maintenance login may re-arm jobs; the request role cannot even call it.
  await expect(
    testContext.database.transaction((transaction) =>
      transaction.query("SELECT lore.requeue_dead_memory_embedding_jobs($1, true)", [report.id]),
    ),
  ).rejects.toThrow(/permission denied/);
  await expect(jobStates(testContext)).resolves.toEqual(before);
});

test("a coverage report for an unseeded generation creates nothing", async () => {
  const testContext = await createMemoryTestContext();
  const provider = unavailableProvider("never-seeded");
  const memories = createMemoryModule(testContext.database);
  await memories.remember(testContext.alice, { content: "Lexical-only Memory." });
  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider: provider,
  });
  const generations = () =>
    testContext.adminDatabase.transaction(async (transaction) => {
      const result = await transaction.query<{ count: string | number }>(
        "SELECT count(*) AS count FROM embedding_generations",
      );
      return Number(result.rows[0]?.count);
    });
  const generationsBefore = await generations();

  await expect(maintenance.findGenerationReport()).resolves.toBeNull();
  await expect(maintenance.generationReport()).rejects.toThrow(
    "Embedding generation is not initialized",
  );
  await expect(generations()).resolves.toBe(generationsBefore);
  await expect(jobStates(testContext)).resolves.toEqual([]);
});
