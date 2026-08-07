// OpenNext generates this module before Wrangler bundles the custom worker.
import openNextWorker from "./.open-next/worker.js";
import { createRequestPostgresDatabase } from "./src/lib/db/postgres";
import { createEmbeddingProviderFromEnvironment } from "./src/lib/embedding/provider-factory";
import {
  createMemoryMaintenanceModule,
  embeddingMaintenanceLeaseSeconds,
} from "./src/lib/maintenance";
import type { MemoryEmbeddingJobMessage } from "./src/lib/memory";

// Preserve any OpenNext Durable Object exports if a cache adapter enables them.
export { BucketCachePurge, DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";

function embeddingEnvironment(env: CloudflareEnv): Record<string, string | undefined> {
  return {
    LORE_EMBEDDING_PROVIDER: env.LORE_EMBEDDING_PROVIDER,
    LORE_EMBEDDING_MODEL: env.LORE_EMBEDDING_MODEL,
    LORE_EMBEDDING_TIMEOUT_MS: env.LORE_EMBEDDING_TIMEOUT_MS,
    GEMINI_API_KEY: env.GEMINI_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    OLLAMA_BASE_URL: env.OLLAMA_BASE_URL,
    OLLAMA_KEEP_ALIVE: env.OLLAMA_KEEP_ALIVE,
  };
}

function maintenanceForEnvironment(env: CloudflareEnv) {
  const provider = createEmbeddingProviderFromEnvironment(embeddingEnvironment(env), (message) =>
    console.warn(message),
  );
  if (!provider) return null;
  const database = createRequestPostgresDatabase(
    { connectionString: env.MAINTENANCE_HYPERDRIVE.connectionString },
    { role: "lore_maintenance" },
  );
  return createMemoryMaintenanceModule(database, {
    embeddingProvider: provider,
    leaseSeconds: embeddingMaintenanceLeaseSeconds(Number(env.LORE_EMBEDDING_TIMEOUT_MS)),
    logger: (entry) => console.log(JSON.stringify({ component: "memory-maintenance", ...entry })),
  });
}

function isJobMessage(value: unknown): value is MemoryEmbeddingJobMessage {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as MemoryEmbeddingJobMessage).jobId === "string"
  );
}

export default {
  fetch: openNextWorker.fetch,

  async queue(batch, env) {
    const maintenance = maintenanceForEnvironment(env);
    if (!maintenance) {
      batch.ackAll();
      return;
    }

    // Process sequentially to bound provider and pg client concurrency inside a
    // single isolate; Queue max_concurrency provides horizontal parallelism.
    for (const message of batch.messages) {
      if (!isJobMessage(message.body)) {
        console.warn("Lore discarded an invalid maintenance queue message");
        message.ack();
        continue;
      }
      try {
        const result = await maintenance.run(message.body.jobId);
        if (result.status === "retry") {
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
  },

  async scheduled(_controller, env) {
    const maintenance = maintenanceForEnvironment(env);
    if (!maintenance) return;
    await maintenance.seedStale(1_000);
    const pending = await maintenance.pending(1_000);
    if (pending.length === 0) return;
    for (let offset = 0; offset < pending.length; offset += 100) {
      await env.MEMORY_MAINTENANCE_QUEUE.sendBatch(
        pending
          .slice(offset, offset + 100)
          .map((jobId) => ({ body: { jobId } satisfies MemoryEmbeddingJobMessage })),
      );
    }
  },
} satisfies ExportedHandler<CloudflareEnv, MemoryEmbeddingJobMessage>;
