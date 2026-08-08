import { createPostgresDatabase } from "../lib/db/postgres";
import { createEmbeddingProviderFromEnvironment } from "../lib/embedding/provider-factory";
import {
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

const buildProvider = process.env.LORE_EMBEDDING_BUILD_PROVIDER?.trim();
const buildModel = process.env.LORE_EMBEDDING_BUILD_MODEL?.trim();
const embeddingEnvironment =
  buildProvider || buildModel
    ? {
        ...process.env,
        LORE_EMBEDDING_PROVIDER: buildProvider || process.env.LORE_EMBEDDING_PROVIDER || "ollama",
        LORE_EMBEDDING_MODEL: buildModel || process.env.LORE_EMBEDDING_MODEL,
      }
    : process.env;
const embeddingProvider = createEmbeddingProviderFromEnvironment(embeddingEnvironment, (message) =>
  console.warn(message),
);

const database = createPostgresDatabase(
  {
    connectionString,
    max: positiveInteger(process.env.LORE_MAINTENANCE_POOL_SIZE, 2),
  },
  { role: "lore_maintenance" },
);
const maintenance = embeddingProvider
  ? createMemoryMaintenanceModule(database, {
      embeddingProvider,
      leaseSeconds: embeddingMaintenanceLeaseSeconds(
        positiveInteger(process.env.LORE_EMBEDDING_TIMEOUT_MS, 120_000),
      ),
      logger: (entry) => console.log(JSON.stringify({ component: "memory-maintenance", ...entry })),
    })
  : null;
const pollIntervalMs = positiveInteger(process.env.LORE_MAINTENANCE_POLL_MS, 1_000);
const sweepIntervalMs = positiveInteger(process.env.LORE_MAINTENANCE_SWEEP_MS, 300_000);
const embeddingRollbackSeconds = positiveInteger(
  process.env.LORE_EMBEDDING_ROLLBACK_SECONDS,
  604_800,
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
          const generation = maintenance ? await maintenance.generationReport() : null;
          return { generation, prunedEmbeddingGenerations, purged, seeded };
        });
        console.log(
          JSON.stringify({
            component: "memory-maintenance",
            event: "sweep_complete",
            seededJobs: sweep.seeded.length,
            purgedIdempotencyRecords: sweep.purged.idempotencyRecords,
            purgedMemoryEvents: sweep.purged.memoryEvents,
            prunedEmbeddingGenerations: sweep.prunedEmbeddingGenerations,
            embeddingStatus: sweep.generation ? "configured" : "disabled",
            generationStatus: sweep.generation?.status,
            generationEligibleChunks: sweep.generation?.eligibleChunks,
            generationEmbeddedChunks: sweep.generation?.embeddedChunks,
            generationMissingChunks: sweep.generation?.missingChunks,
            generationPendingJobs: sweep.generation?.pendingJobs,
            generationDeadJobs: sweep.generation?.deadJobs,
          }),
        );
        nextSweepAt = Date.now() + sweepIntervalMs;
      }

      infrastructureBackoffMs = pollIntervalMs;
      if (!maintenance) {
        await wait(pollIntervalMs);
        continue;
      }
      const result = await observeOperation("maintenance.job", () => maintenance.run());
      if (result.status === "idle" || result.status === "retry") {
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
