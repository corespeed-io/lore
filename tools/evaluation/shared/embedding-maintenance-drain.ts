import type { MemoryMaintenanceResult } from "@corespeed/lore-core";
import type pg from "pg";

/** Embedding jobs still pending in a disposable benchmark database. */
export async function pendingEmbeddingJobCount(client: pg.Client): Promise<number> {
  const backlog = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM memory_embedding_jobs WHERE status = 'pending'",
  );
  return Number(backlog.rows[0]?.count ?? 0);
}

export interface EmbeddingMaintenanceDrainOptions {
  /** One leased maintenance attempt (the Maintenance module's `run`). */
  run: () => Promise<MemoryMaintenanceResult>;
  /** Independent leases attempted per round. */
  concurrency: number;
  /** Jobs still waiting, including ones backed off until a later `run_at`. */
  pendingJobCount: () => Promise<number>;
  /** Called after each round that completed jobs. */
  onProgress?: (completedJobs: number, roundCompleted: number) => void;
  sleep?: (seconds: number) => Promise<void>;
  /** Consecutive rounds without a completion before giving up. */
  maximumStalledRounds?: number;
}

/**
 * Drain a benchmark's embedding jobs to completion. Provider throttling (429
 * bursts) exhausts an adapter's inline retries and parks jobs with a durable
 * backoff; a backed-off job also makes `run` report idle until its `run_at`
 * arrives. Waiting is safe, so a retry never aborts the run: only a dead job or
 * sustained zero progress does. Returns the number of completed jobs.
 */
export async function drainEmbeddingMaintenance(
  options: EmbeddingMaintenanceDrainOptions,
): Promise<number> {
  const sleep =
    options.sleep ??
    ((seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1_000)));
  const maximumStalledRounds = options.maximumStalledRounds ?? 40;
  let completedJobs = 0;
  let stalledRounds = 0;
  while (true) {
    const results = await Promise.all(
      Array.from({ length: options.concurrency }, () => options.run()),
    );
    let roundCompleted = 0;
    let retryAfterSeconds = 0;
    for (const result of results) {
      // `lost` means another run owns (or the Memory no longer needs) that lease:
      // no completion to count, and nothing to back off from.
      if (result.status === "idle" || result.status === "lost") continue;
      if (result.status === "dead") {
        throw new Error(`Embedding job ${result.jobId ?? "unknown"} ended as dead`);
      }
      if (result.status === "retry") {
        retryAfterSeconds = Math.max(
          retryAfterSeconds,
          Math.min(result.retryAfterSeconds ?? 30, 60),
        );
        continue;
      }
      completedJobs += 1;
      roundCompleted += 1;
    }
    if (roundCompleted > 0) {
      stalledRounds = 0;
      options.onProgress?.(completedJobs, roundCompleted);
      continue;
    }
    if (results.every((result) => result.status === "idle" || result.status === "lost")) {
      if ((await options.pendingJobCount()) === 0) break;
      retryAfterSeconds = Math.max(retryAfterSeconds, 15);
    }
    stalledRounds += 1;
    if (stalledRounds > maximumStalledRounds) {
      throw new Error(
        `Embedding maintenance made no progress across ${maximumStalledRounds} throttled rounds; giving up`,
      );
    }
    await sleep(Math.max(retryAfterSeconds, 15));
  }
  return completedJobs;
}
