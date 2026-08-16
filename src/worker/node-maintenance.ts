import { createCodeIndexMaintenanceModule } from "../lib/code-index";
import { createPostgresDatabase } from "../lib/db/postgres";
import { createMaintenanceEmbeddingProvidersFromEnvironment } from "../lib/embedding/provider-factory";
import {
  createMemoryMaintenanceCoordinator,
  createMemoryMaintenanceModule,
  embeddingMaintenanceLeaseSeconds,
  pruneRetiringEmbeddingGenerations,
  purgeExpiredPortableCoreRecords,
} from "../lib/maintenance";
import { registerLoreTelemetry } from "../lib/register-telemetry";
import { observeOperation } from "../lib/telemetry";

registerLoreTelemetry();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const connectionString = process.env.LORE_MAINTENANCE_DATABASE_URL;
if (!connectionString) {
  throw new Error("LORE_MAINTENANCE_DATABASE_URL is required by the maintenance worker");
}

const embeddingProviders = createMaintenanceEmbeddingProvidersFromEnvironment(
  process.env,
  (message) => console.warn(message),
);

const database = createPostgresDatabase(
  {
    connectionString,
    max: positiveInteger(process.env.LORE_MAINTENANCE_POOL_SIZE, 2),
  },
  { role: "lore_maintenance" },
);
const maintenanceModules = embeddingProviders.map((embeddingProvider) =>
  createMemoryMaintenanceModule(database, {
    embeddingProvider,
    leaseSeconds: embeddingMaintenanceLeaseSeconds(
      positiveInteger(process.env.LORE_EMBEDDING_TIMEOUT_MS, 120_000),
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
const codeIndexMaintenance = createCodeIndexMaintenanceModule(database, {
  logger: (entry) =>
    console.log(
      JSON.stringify({
        component: "code-index-maintenance",
        ...entry,
      }),
    ),
});
const pollIntervalMs = positiveInteger(process.env.LORE_MAINTENANCE_POLL_MS, 1_000);
const sweepIntervalMs = positiveInteger(process.env.LORE_MAINTENANCE_SWEEP_MS, 300_000);
const embeddingRollbackSeconds = positiveInteger(
  process.env.LORE_EMBEDDING_ROLLBACK_SECONDS,
  604_800,
);
const workerConcurrency = Math.min(
  positiveInteger(process.env.LORE_MAINTENANCE_CONCURRENCY, 1),
  32,
);
let stopping = false;

function requestStop(): void {
  stopping = true;
}

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

try {
  let nextSweepAt = 0;
  let infrastructureBackoffMs = pollIntervalMs;
  while (!stopping) {
    try {
      if (Date.now() >= nextSweepAt) {
        const sweep = await observeOperation("maintenance.sweep", async () => {
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
            seededJobs: sweep.seeded.length,
            purgedIdempotencyRecords: sweep.purged.idempotencyRecords,
            purgedMemoryEvents: sweep.purged.memoryEvents,
            prunedEmbeddingGenerations: sweep.prunedEmbeddingGenerations,
            embeddingStatus: sweep.generations.length > 0 ? "configured" : "disabled",
            embeddingGenerations: sweep.generations,
          }),
        );
        nextSweepAt = Date.now() + sweepIntervalMs;
      }

      const codeIndexResult = await observeOperation("code-index-maintenance.job", () =>
        codeIndexMaintenance.run(),
      );
      const results = maintenance
        ? await Promise.all(
            Array.from({ length: workerConcurrency }, () =>
              observeOperation("maintenance.job", () => maintenance.run()),
            ),
          )
        : [];
      infrastructureBackoffMs = pollIntervalMs;
      if (
        (codeIndexResult.status === "idle" || codeIndexResult.status === "retry") &&
        results.every((result) => result.status === "idle" || result.status === "retry")
      ) {
        await wait(pollIntervalMs);
      }
    } catch {
      console.error(
        JSON.stringify({
          component: "memory-maintenance",
          event: "infrastructure_error",
        }),
      );
      await wait(infrastructureBackoffMs);
      infrastructureBackoffMs = Math.min(infrastructureBackoffMs * 2, 60_000);
    }
  }
} finally {
  await database.close();
}
