import { createPostgresDatabase } from "../lib/db/postgres";
import { createEmbeddingProviderFromEnvironment } from "../lib/embedding/provider-factory";
import {
  createMemoryMaintenanceModule,
  embeddingMaintenanceLeaseSeconds,
} from "../lib/maintenance";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const connectionString = process.env.LORE_MAINTENANCE_DATABASE_URL;
if (!connectionString) {
  throw new Error("LORE_MAINTENANCE_DATABASE_URL is required by the maintenance worker");
}

const embeddingProvider = createEmbeddingProviderFromEnvironment(process.env, (message) =>
  console.warn(message),
);
if (!embeddingProvider) {
  throw new Error("A valid deployment-wide embedding configuration is required by the worker");
}

const database = createPostgresDatabase(
  {
    connectionString,
    max: positiveInteger(process.env.LORE_MAINTENANCE_POOL_SIZE, 2),
  },
  { role: "lore_maintenance" },
);
const maintenance = createMemoryMaintenanceModule(database, {
  embeddingProvider,
  leaseSeconds: embeddingMaintenanceLeaseSeconds(
    positiveInteger(process.env.LORE_EMBEDDING_TIMEOUT_MS, 120_000),
  ),
  logger: (entry) => console.log(JSON.stringify({ component: "memory-maintenance", ...entry })),
});
const pollIntervalMs = positiveInteger(process.env.LORE_MAINTENANCE_POLL_MS, 1_000);
const sweepIntervalMs = positiveInteger(process.env.LORE_MAINTENANCE_SWEEP_MS, 300_000);
let stopping = false;

function requestStop(): void {
  stopping = true;
}

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

async function waitForNextPoll(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
}

try {
  let nextSweepAt = 0;
  while (!stopping) {
    if (Date.now() >= nextSweepAt) {
      const seeded = await maintenance.seedStale(1_000);
      console.log(
        JSON.stringify({
          component: "memory-maintenance",
          event: "sweep_complete",
          seededJobs: seeded.length,
        }),
      );
      nextSweepAt = Date.now() + sweepIntervalMs;
    }

    const result = await maintenance.run();
    if (result.status === "idle" || result.status === "retry") {
      await waitForNextPoll();
    }
  }
} finally {
  await database.close();
}
