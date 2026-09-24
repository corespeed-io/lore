import { expect, test } from "vitest";
import type { MaintenanceLoopName } from "@/worker/maintenance-loops";
import { runMaintenanceLoops } from "@/worker/maintenance-loops";

const SWEEP_INTERVAL_MS = 99_999;

test("a failing loop backs off exponentially to its cap and resets after one success", async () => {
  const stop = new AbortController();
  const errors: MaintenanceLoopName[] = [];
  const waits: number[] = [];
  // Five infrastructure failures, a quiet success, one more failure, and a last success.
  const outcomes = ["fail", "fail", "fail", "fail", "fail", "idle", "fail", "idle"] as const;
  let calls = 0;

  await runMaintenanceLoops({
    signal: stop.signal,
    pollIntervalMs: 10,
    maximumBackoffMs: 40,
    sweepIntervalMs: SWEEP_INTERVAL_MS,
    embeddingConcurrency: 1,
    sweep: async () => undefined,
    onInfrastructureError: (loop) => errors.push(loop),
    wait: async (milliseconds) => {
      if (milliseconds !== SWEEP_INTERVAL_MS) waits.push(milliseconds);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    embeddingJob: async () => {
      const outcome = outcomes[calls] ?? "idle";
      calls += 1;
      if (calls >= outcomes.length) stop.abort();
      if (outcome === "fail") throw new Error("database unavailable");
      return { status: outcome };
    },
  });

  expect(errors).toEqual(Array.from({ length: 6 }, () => "embedding"));
  // 10, 20, 40, then capped at 40. The quiet success polls at 10 and resets the
  // backoff, so the next failure waits 10 again instead of the cap. The last
  // success arrives after the stop, so it waits for nothing.
  expect(waits).toEqual([10, 20, 40, 40, 40, 10, 10]);
});
