import { expect, test } from "vitest";
import type { MaintenanceLoopName, MaintenanceLoopOptions } from "@/worker/maintenance-loops";
import { runMaintenanceCycle, runMaintenanceLoops } from "@/worker/maintenance-loops";

function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition was not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function loopOptions(overrides: Partial<MaintenanceLoopOptions>): MaintenanceLoopOptions {
  return {
    signal: new AbortController().signal,
    pollIntervalMs: 5,
    sweepIntervalMs: 60_000,
    embeddingConcurrency: 1,
    sweep: async () => undefined,
    onInfrastructureError: () => undefined,
    ...overrides,
  };
}

test("a long Code Index job does not starve embedding maintenance", async () => {
  const stop = new AbortController();
  const codeIndexRelease = deferred();
  let codeIndexCalls = 0;
  let embeddingCalls = 0;
  const loops = runMaintenanceLoops(
    loopOptions({
      signal: stop.signal,
      codeIndexJob: async () => {
        codeIndexCalls += 1;
        await codeIndexRelease.promise;
        return { status: "complete" };
      },
      embeddingJob: async () => {
        embeddingCalls += 1;
        return { status: "complete" };
      },
    }),
  );

  await until(() => embeddingCalls >= 5);
  expect(codeIndexCalls).toBe(1);
  stop.abort();
  codeIndexRelease.resolve();
  await loops;
});

test("a stalled embedding provider does not starve Code Index jobs or the sweep", async () => {
  const stop = new AbortController();
  const embeddingRelease = deferred();
  let codeIndexCalls = 0;
  let sweeps = 0;
  const loops = runMaintenanceLoops(
    loopOptions({
      signal: stop.signal,
      sweepIntervalMs: 5,
      sweep: async () => {
        sweeps += 1;
      },
      codeIndexJob: async () => {
        codeIndexCalls += 1;
        return { status: "complete" };
      },
      embeddingJob: async () => {
        await embeddingRelease.promise;
        return { status: "complete" };
      },
    }),
  );

  await until(() => codeIndexCalls >= 5 && sweeps >= 3);
  stop.abort();
  embeddingRelease.resolve();
  await loops;
});

test("an embedding round never exceeds its concurrency, even when one lane fails", async () => {
  const stop = new AbortController();
  const slowLane = deferred();
  const errors: MaintenanceLoopName[] = [];
  let running = 0;
  let peak = 0;
  let started = 0;
  const loops = runMaintenanceLoops(
    loopOptions({
      signal: stop.signal,
      embeddingConcurrency: 2,
      onInfrastructureError: (loop) => errors.push(loop),
      embeddingJob: async () => {
        started += 1;
        running += 1;
        peak = Math.max(peak, running);
        try {
          if (started === 1) throw new Error("database unavailable");
          if (started === 2) await slowLane.promise;
          return { status: "idle" };
        } finally {
          running -= 1;
        }
      },
    }),
  );

  await until(() => started === 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  // The failed lane must not release a new round while its sibling still runs.
  expect(started).toBe(2);
  expect(errors).toEqual([]);
  slowLane.resolve();
  await until(() => errors.length === 1 && started > 2);
  expect(errors).toEqual(["embedding"]);
  expect(peak).toBeLessThanOrEqual(2);
  stop.abort();
  await loops;
});

test("a lost lease is a normal outcome that polls again without backoff", async () => {
  const stop = new AbortController();
  const errors: MaintenanceLoopName[] = [];
  const waits: number[] = [];
  let calls = 0;
  const loops = runMaintenanceLoops(
    loopOptions({
      signal: stop.signal,
      pollIntervalMs: 1_000,
      onInfrastructureError: (loop) => errors.push(loop),
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      embeddingJob: async () => {
        calls += 1;
        if (calls >= 4) stop.abort();
        return { status: "lost" };
      },
    }),
  );

  await loops;
  expect(errors).toEqual([]);
  // Only the sweep loop paused; the lost embedding rounds never waited.
  expect(waits.filter((milliseconds) => milliseconds !== 60_000)).toEqual([]);
});

test("stopping cuts a long infrastructure backoff short", async () => {
  const stop = new AbortController();
  let sweeps = 0;
  const loops = runMaintenanceLoops(
    loopOptions({
      signal: stop.signal,
      pollIntervalMs: 60_000,
      sweep: async () => {
        sweeps += 1;
        throw new Error("database unavailable");
      },
    }),
  );
  await until(() => sweeps === 1);
  const stoppedAt = Date.now();
  stop.abort();
  await loops;
  expect(Date.now() - stoppedAt).toBeLessThan(1_000);
});

test("one maintenance cycle runs every step once and reports any failure", async () => {
  const steps: string[] = [];
  const errors: MaintenanceLoopName[] = [];
  const result = await runMaintenanceCycle(
    loopOptions({
      embeddingConcurrency: 2,
      onInfrastructureError: (loop) => errors.push(loop),
      sweep: async () => {
        steps.push("sweep");
        throw new Error("sweep failed");
      },
      codeIndexJob: async () => {
        steps.push("code-index");
        return { status: "idle" };
      },
      embeddingJob: async () => {
        steps.push("embedding");
        return { status: "retry" };
      },
    }),
  );

  expect(steps).toEqual(["sweep", "code-index", "embedding", "embedding"]);
  expect(errors).toEqual(["sweep"]);
  expect(result).toEqual({
    ok: false,
    sweep: "failed",
    codeIndex: "idle",
    embedding: ["retry", "retry"],
  });
  await expect(runMaintenanceCycle(loopOptions({}))).resolves.toEqual({
    ok: true,
    sweep: "ok",
    codeIndex: "disabled",
    embedding: [],
  });
});
