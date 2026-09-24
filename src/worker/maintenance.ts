import {
  createMemoryMaintenanceCoordinator,
  createMemoryMaintenanceModule,
  embeddingMaintenanceLeaseSeconds,
  pruneRetiringEmbeddingGenerations,
} from "@corespeed/lore-core";
import { createCodeIndexMaintenanceModule } from "@/modules/code/indexing/maintenance";
import { configuredCodeRepositoriesFromEnvironment } from "@/modules/code/indexing/queue";
import { purgeExpiredPortableCoreRecords } from "@/modules/operations/maintenance";
import { createPostgresDatabase } from "@/server/database/postgres";
import { createMaintenanceEmbeddingProvidersFromEnvironment } from "@/server/providers/embedding/factory";
import { registerLoreTelemetry } from "@/server/telemetry/register";
import { observeOperation } from "@/server/telemetry/telemetry";
import type { MaintenanceLoopName, MaintenanceLoopOptions } from "./maintenance-loops";
import { runMaintenanceCycle, runMaintenanceLoops } from "./maintenance-loops";

registerLoreTelemetry();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// `--once` runs a single sweep, Code Index claim, and embedding round, then
// exits 0 only if none of them raised. CI uses it to prove the built bundle can
// connect and claim as the maintenance login.
const runOnce = process.argv.slice(2).includes("--once");

const connectionString = process.env.LORE_MAINTENANCE_DATABASE_URL;
if (!connectionString) {
  throw new Error("LORE_MAINTENANCE_DATABASE_URL is required by the maintenance worker");
}

const embeddingProviders = createMaintenanceEmbeddingProvidersFromEnvironment(
  process.env,
  (message) => console.warn(message),
);
// The worker resolves repository paths from its own registry rather than the
// path stored in a job row, and an empty registry disables Code Indexing here
// (jobs stay pending for a worker that has one), matching the request path.
const codeRepositories = configuredCodeRepositoriesFromEnvironment(process.env, (message) =>
  console.warn(message),
);
const workerConcurrency = Math.min(
  positiveInteger(process.env.LORE_MAINTENANCE_CONCURRENCY, 1),
  32,
);

// One connection per embedding lane plus the Code Index and sweep loops.
const database = createPostgresDatabase(
  {
    connectionString,
    max: positiveInteger(process.env.LORE_MAINTENANCE_POOL_SIZE, workerConcurrency + 2),
  },
  { role: "lore_maintenance" },
);
const maintenanceModules = embeddingProviders.map((embeddingProvider) =>
  createMemoryMaintenanceModule(database, {
    embeddingProvider,
    leaseSeconds: embeddingMaintenanceLeaseSeconds(
      // Ollama ignores the request timeout; use the default reclaim window.
      embeddingProvider.provider === "ollama"
        ? undefined
        : positiveInteger(process.env.LORE_EMBEDDING_TIMEOUT_MS, 120_000),
    ),
    logger: (entry) =>
      console.log(
        JSON.stringify({
          component: "memory-maintenance",
          embeddingProvider: embeddingProvider.provider,
          embeddingModel: embeddingProvider.model,
          embeddingRevision: embeddingProvider.revision,
          ...entry,
        }),
      ),
  }),
);
const maintenance =
  maintenanceModules.length > 0 ? createMemoryMaintenanceCoordinator(maintenanceModules) : null;
const codeIndexMaintenance =
  Object.keys(codeRepositories).length > 0
    ? createCodeIndexMaintenanceModule(database, {
        repositories: codeRepositories,
        logger: (entry) =>
          console.log(
            JSON.stringify({
              component: "code-index-maintenance",
              ...entry,
            }),
          ),
      })
    : null;
if (!codeIndexMaintenance) {
  console.log(
    JSON.stringify({
      component: "code-index-maintenance",
      event: "disabled",
      reason: "LORE_CODE_REPOSITORIES configures no repository for this worker",
    }),
  );
}
const pollIntervalMs = positiveInteger(process.env.LORE_MAINTENANCE_POLL_MS, 1_000);
const sweepIntervalMs = positiveInteger(process.env.LORE_MAINTENANCE_SWEEP_MS, 300_000);
const embeddingRollbackSeconds = positiveInteger(
  process.env.LORE_EMBEDDING_ROLLBACK_SECONDS,
  604_800,
);

const stop = new AbortController();
function requestStop(): void {
  stop.abort();
}

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

async function sweep(): Promise<void> {
  const result = await observeOperation("maintenance.sweep", async () => {
    const purged = await purgeExpiredPortableCoreRecords(database);
    const prunedEmbeddingGenerations = await pruneRetiringEmbeddingGenerations(
      database,
      embeddingRollbackSeconds,
    );
    const seeded = maintenance ? await maintenance.seedStale(1_000) : [];
    const generations = maintenance ? await maintenance.generationReports() : [];
    return { generations, prunedEmbeddingGenerations, purged, seeded };
  });
  console.log(
    JSON.stringify({
      component: "memory-maintenance",
      event: "sweep_complete",
      seededJobs: result.seeded.length,
      purgedIdempotencyRecords: result.purged.idempotencyRecords,
      purgedMemoryEvents: result.purged.memoryEvents,
      prunedEmbeddingGenerations: result.prunedEmbeddingGenerations,
      embeddingStatus: result.generations.length > 0 ? "configured" : "disabled",
      embeddingGenerations: result.generations,
    }),
  );
}

function reportInfrastructureError(loop: MaintenanceLoopName, error: unknown): void {
  // Error messages can carry connection strings or provider payloads; log only
  // which loop failed and the error class.
  console.error(
    JSON.stringify({
      component: loop === "code-index" ? "code-index-maintenance" : "memory-maintenance",
      event: "infrastructure_error",
      loop,
      errorClass: error instanceof Error ? error.constructor.name : "NonErrorThrow",
    }),
  );
}

const loopOptions: MaintenanceLoopOptions = {
  signal: stop.signal,
  pollIntervalMs,
  sweepIntervalMs,
  embeddingConcurrency: workerConcurrency,
  sweep,
  ...(codeIndexMaintenance
    ? {
        codeIndexJob: () =>
          observeOperation("code-index-maintenance.job", () => codeIndexMaintenance.run()),
      }
    : {}),
  ...(maintenance
    ? { embeddingJob: () => observeOperation("maintenance.job", () => maintenance.run()) }
    : {}),
  onInfrastructureError: reportInfrastructureError,
};

let exitCode = 0;
try {
  if (runOnce) {
    const cycle = await runMaintenanceCycle(loopOptions);
    console.log(JSON.stringify({ component: "maintenance", event: "cycle_complete", ...cycle }));
    if (!cycle.ok) exitCode = 1;
  } else {
    await runMaintenanceLoops(loopOptions);
  }
} finally {
  await database.close();
}
process.exitCode = exitCode;
