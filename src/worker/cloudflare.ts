// OpenNext generates this module before Wrangler bundles the custom worker.

import type { MemoryEmbeddingJobMessage } from "@corespeed/lore-core";
import { createEmbeddingMaintenance } from "@corespeed/lore-core";
import openNextWorker from "../../.open-next/worker.js";
import { purgeExpiredPortableCoreRecords } from "../modules/operations/maintenance";
import { isApiPath } from "../server/api/app";
import { fetchCloudflareApi } from "../server/api/cloudflare";
import {
  createRequestPostgresDatabase,
  postgresPipeline,
  type RuntimePostgresDatabase,
} from "../server/database/postgres";
import { createMaintenanceEmbeddingProvidersFromEnvironment } from "../server/providers/embedding/factory";

// Preserve any OpenNext Durable Object exports if a cache adapter enables them.
export { BucketCachePurge, DOQueueHandler, DOShardedTagCache } from "../../.open-next/worker.js";

function embeddingEnvironment(env: CloudflareEnv): Record<string, string | undefined> {
  return {
    LORE_EMBEDDING_PROVIDER: env.LORE_EMBEDDING_PROVIDER,
    LORE_EMBEDDING_MODEL: env.LORE_EMBEDDING_MODEL,
    LORE_EMBEDDING_BUILD_PROVIDER: env.LORE_EMBEDDING_BUILD_PROVIDER,
    LORE_EMBEDDING_BUILD_MODEL: env.LORE_EMBEDDING_BUILD_MODEL,
    LORE_EMBEDDING_TIMEOUT_MS: env.LORE_EMBEDDING_TIMEOUT_MS,
    GEMINI_API_KEY: env.GEMINI_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    AI_GATEWAY_API_KEY: env.AI_GATEWAY_API_KEY,
    OLLAMA_BASE_URL: env.OLLAMA_BASE_URL,
    OLLAMA_KEEP_ALIVE: env.OLLAMA_KEEP_ALIVE,
  };
}

function maintenanceForEnvironment(env: CloudflareEnv, database: RuntimePostgresDatabase) {
  return createEmbeddingMaintenance(database, {
    embeddingProviders: createMaintenanceEmbeddingProvidersFromEnvironment(
      embeddingEnvironment(env),
      (message) => console.warn(message),
    ),
    generationRetentionSeconds: Number(env.LORE_EMBEDDING_ROLLBACK_SECONDS) || 604_800,
    logger: (entry) => console.log(JSON.stringify({ component: "memory-maintenance", ...entry })),
  });
}

/** Connections for one queue batch or cron run; the handler closes them when it ends. */
function maintenanceDatabaseForEnvironment(env: CloudflareEnv): RuntimePostgresDatabase {
  return createRequestPostgresDatabase(
    { connectionString: env.MAINTENANCE_HYPERDRIVE.connectionString },
    { role: "lore_maintenance", pipeline: postgresPipeline(env.LORE_POSTGRES_PIPELINE, false) },
  );
}

export default {
  async fetch(request, env, context) {
    // Keep orchestration probes outside the Next/OpenNext request path. A live
    // process must remain observable even when application auth or rendering is
    // unhealthy, and readiness needs only the request-scoped Hyperdrive client.
    const path = new URL(request.url).pathname;
    if (isApiPath(path)) return fetchCloudflareApi(request, env, context);
    return openNextWorker.fetch(request, env, context);
  },

  async queue(batch, env) {
    const database = maintenanceDatabaseForEnvironment(env);
    try {
      const maintenance = maintenanceForEnvironment(env, database);
      if (!maintenance.enabled) {
        batch.ackAll();
        return;
      }

      // Process sequentially to bound provider and pg client concurrency inside a
      // single isolate; Queue max_concurrency provides horizontal parallelism.
      for (const message of batch.messages) {
        try {
          const result = await maintenance.run(message.body);
          if (result.status === "invalid") {
            console.warn("Lore discarded an invalid maintenance queue message");
            message.ack();
          } else if (result.status === "retry") {
            message.retry({ delaySeconds: result.retryAfterSeconds });
          } else {
            message.ack();
          }
        } catch {
          console.error(
            JSON.stringify({
              component: "memory-maintenance",
              event: "job_infrastructure_error",
              jobId: message.body.jobId,
            }),
          );
          message.retry();
        }
      }
    } finally {
      await database.close();
    }
  },

  async scheduled(_controller, env) {
    const database = maintenanceDatabaseForEnvironment(env);
    try {
      const purged = await purgeExpiredPortableCoreRecords(database);
      const maintenance = maintenanceForEnvironment(env, database);
      const sweep = await maintenance.sweep();
      if (!maintenance.enabled) {
        console.log(
          JSON.stringify({
            component: "memory-maintenance",
            event: "sweep_complete",
            embeddingStatus: "disabled",
            purgedIdempotencyRecords: purged.idempotencyRecords,
            purgedMemoryEvents: purged.memoryEvents,
            prunedEmbeddingGenerations: sweep.prunedGenerations,
          }),
        );
        return;
      }
      console.log(
        JSON.stringify({
          component: "memory-maintenance",
          event: "sweep_complete",
          seededJobs: sweep.seeded.length,
          purgedIdempotencyRecords: purged.idempotencyRecords,
          purgedMemoryEvents: purged.memoryEvents,
          prunedEmbeddingGenerations: sweep.prunedGenerations,
          embeddingGenerations: sweep.generations,
        }),
      );
      const pending = await maintenance.pending(1_000);
      for (let offset = 0; offset < pending.length; offset += 100) {
        await env.MEMORY_MAINTENANCE_QUEUE.sendBatch(
          pending.slice(offset, offset + 100).map((body) => ({ body })),
        );
      }
    } finally {
      await database.close();
    }
  },
} satisfies ExportedHandler<CloudflareEnv, MemoryEmbeddingJobMessage>;
