// Scheduling for the self-host maintenance worker. Discovery sweeps, Code Index
// jobs, and embedding jobs run as independent loops: a long Code Index job must
// not starve embeddings, and a stalled embedding provider must not starve Code
// Index jobs or the retention sweep. Each loop backs off on its own failures.

export type MaintenanceLoopName = "code-index" | "embedding" | "sweep";

export interface MaintenanceJobOutcome {
  status: string;
}

export interface MaintenanceLoopOptions {
  /** Aborting it stops every loop after its current iteration and cuts waits short. */
  signal: AbortSignal;
  pollIntervalMs: number;
  sweepIntervalMs: number;
  /** Upper bound of the per-loop infrastructure backoff. */
  maximumBackoffMs?: number;
  /** Independent embedding leases claimed per round (LORE_MAINTENANCE_CONCURRENCY). */
  embeddingConcurrency: number;
  sweep: () => Promise<void>;
  /** Absent when this worker has no Code Repository registry. */
  codeIndexJob?: () => Promise<MaintenanceJobOutcome>;
  /** Absent when no embedding generation is configured. */
  embeddingJob?: () => Promise<MaintenanceJobOutcome>;
  onInfrastructureError: (loop: MaintenanceLoopName, error: unknown) => void;
  /** Test seam; defaults to an abortable timer. */
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface MaintenanceCycleResult {
  ok: boolean;
  sweep: "failed" | "ok";
  codeIndex: string;
  embedding: string[];
}

/** `idle` and `retry` mean nothing is claimable now; anything else polls again at once. */
function isQuiet(status: string): boolean {
  return status === "idle" || status === "retry";
}

export function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function embeddingRound(options: MaintenanceLoopOptions): Promise<string[]> {
  const embeddingJob = options.embeddingJob;
  if (!embeddingJob) return [];
  // allSettled keeps a failing lane from releasing the round early while its
  // siblings still hold leases, so at most `embeddingConcurrency` run at once.
  const settled = await Promise.allSettled(
    Array.from({ length: options.embeddingConcurrency }, () => embeddingJob()),
  );
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value.status] : []));
}

async function repeat(
  name: MaintenanceLoopName,
  options: MaintenanceLoopOptions,
  iteration: () => Promise<number>,
): Promise<void> {
  const wait = options.wait ?? abortableWait;
  const maximumBackoffMs = options.maximumBackoffMs ?? 60_000;
  let backoffMs = options.pollIntervalMs;
  while (!options.signal.aborted) {
    try {
      const pauseMs = await iteration();
      backoffMs = options.pollIntervalMs;
      if (pauseMs > 0 && !options.signal.aborted) await wait(pauseMs, options.signal);
      // Back-to-back iterations still yield a macrotask turn, so an iteration that
      // settles without real I/O can never starve timers, signals, or other loops.
      else await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } catch (error) {
      options.onInfrastructureError(name, error);
      if (!options.signal.aborted) await wait(backoffMs, options.signal);
      backoffMs = Math.min(backoffMs * 2, maximumBackoffMs);
    }
  }
}

/** Runs every configured loop until the signal aborts. Never rejects. */
export async function runMaintenanceLoops(options: MaintenanceLoopOptions): Promise<void> {
  const loops = [
    repeat("sweep", options, async () => {
      await options.sweep();
      return options.sweepIntervalMs;
    }),
  ];
  const codeIndexJob = options.codeIndexJob;
  if (codeIndexJob) {
    loops.push(
      repeat("code-index", options, async () =>
        isQuiet((await codeIndexJob()).status) ? options.pollIntervalMs : 0,
      ),
    );
  }
  if (options.embeddingJob) {
    loops.push(
      repeat("embedding", options, async () =>
        (await embeddingRound(options)).every(isQuiet) ? options.pollIntervalMs : 0,
      ),
    );
  }
  await Promise.all(loops);
}

/**
 * One sweep, one Code Index claim, and one embedding round, in that order. Every
 * step runs even after an earlier one fails, so a smoke run exercises each
 * database path; `ok` is false when any step raised.
 */
export async function runMaintenanceCycle(
  options: MaintenanceLoopOptions,
): Promise<MaintenanceCycleResult> {
  const result: MaintenanceCycleResult = {
    ok: true,
    sweep: "ok",
    codeIndex: options.codeIndexJob ? "failed" : "disabled",
    embedding: [],
  };
  try {
    await options.sweep();
  } catch (error) {
    result.ok = false;
    result.sweep = "failed";
    options.onInfrastructureError("sweep", error);
  }
  if (options.codeIndexJob) {
    try {
      result.codeIndex = (await options.codeIndexJob()).status;
    } catch (error) {
      result.ok = false;
      options.onInfrastructureError("code-index", error);
    }
  }
  try {
    result.embedding = await embeddingRound(options);
  } catch (error) {
    result.ok = false;
    result.embedding = ["failed"];
    options.onInfrastructureError("embedding", error);
  }
  return result;
}
