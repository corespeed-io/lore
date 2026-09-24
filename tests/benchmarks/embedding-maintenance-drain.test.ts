import type { MemoryMaintenanceResult } from "@corespeed/lore-core";
import { expect, test } from "vitest";
import { drainEmbeddingMaintenance } from "../../tools/evaluation/shared/embedding-maintenance-drain";

function scripted(results: MemoryMaintenanceResult[]) {
  const queue = [...results];
  return async (): Promise<MemoryMaintenanceResult> => queue.shift() ?? { status: "idle" };
}

test("a retried job does not abort the drain and its backoff is honored", async () => {
  const sleeps: number[] = [];
  const completed = await drainEmbeddingMaintenance({
    run: scripted([
      { status: "retry", jobId: "job-1", retryAfterSeconds: 40 },
      { status: "complete", jobId: "job-1" },
      { status: "complete", jobId: "job-2" },
    ]),
    concurrency: 1,
    pendingJobCount: async () => 0,
    sleep: async (seconds) => {
      sleeps.push(seconds);
    },
  });
  expect(completed).toBe(2);
  expect(sleeps).toEqual([40]);
});

test("an idle round with a backed-off backlog waits instead of stopping early", async () => {
  const sleeps: number[] = [];
  let pending = 1;
  const completed = await drainEmbeddingMaintenance({
    run: scripted([{ status: "idle" }, { status: "complete", jobId: "job-1" }]),
    concurrency: 1,
    pendingJobCount: async () => {
      const current = pending;
      pending = 0;
      return current;
    },
    sleep: async (seconds) => {
      sleeps.push(seconds);
    },
  });
  expect(completed).toBe(1);
  expect(sleeps).toEqual([15]);
});

test("progress reports each completing round across concurrent leases", async () => {
  const progress: Array<[number, number]> = [];
  const completed = await drainEmbeddingMaintenance({
    run: scripted([
      { status: "complete", jobId: "job-1" },
      { status: "complete", jobId: "job-2" },
      { status: "complete", jobId: "job-3" },
    ]),
    concurrency: 2,
    pendingJobCount: async () => 0,
    onProgress: (total, round) => progress.push([total, round]),
    sleep: async () => undefined,
  });
  expect(completed).toBe(3);
  expect(progress).toEqual([
    [2, 2],
    [3, 1],
  ]);
});

test("a dead job or sustained zero progress aborts the drain", async () => {
  await expect(
    drainEmbeddingMaintenance({
      run: scripted([{ status: "dead", jobId: "job-9" }]),
      concurrency: 1,
      pendingJobCount: async () => 0,
      sleep: async () => undefined,
    }),
  ).rejects.toThrow("Embedding job job-9 ended as dead");

  await expect(
    drainEmbeddingMaintenance({
      run: async () => ({ status: "retry", jobId: "job-1", retryAfterSeconds: 1 }),
      concurrency: 1,
      pendingJobCount: async () => 1,
      maximumStalledRounds: 2,
      sleep: async () => undefined,
    }),
  ).rejects.toThrow("no progress across 2 throttled rounds");
});
