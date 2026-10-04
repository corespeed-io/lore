import { configuredCodeRepositoriesFromEnvironment } from "@/modules/code/indexing/queue";
import {
  createRequestPostgresDatabase,
  postgresPipeline,
  type RuntimePostgresDatabase,
} from "@/server/database/postgres";
import { getRuntimeMemoryModuleOptions } from "@/server/providers/runtime";
import { createApi } from "./app";

/**
 * Each request gets its own Hyperdrive connections, reused by every transaction of
 * the request and closed once its response is ready; sockets never cross request
 * lifetimes.
 */
export async function fetchCloudflareApi(
  request: Request,
  env: Pick<CloudflareEnv, "HYPERDRIVE" | "MEMORY_MAINTENANCE_QUEUE" | "LORE_POSTGRES_PIPELINE">,
  context: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  let database: RuntimePostgresDatabase | undefined;
  const app = createApi({
    database: () => {
      database ??= createRequestPostgresDatabase(
        { connectionString: env.HYPERDRIVE.connectionString },
        { pipeline: postgresPipeline(env.LORE_POSTGRES_PIPELINE, false) },
      );
      return database;
    },
    memoryOptions: () =>
      getRuntimeMemoryModuleOptions({
        maintenanceNotifier: {
          notify(message) {
            context.waitUntil(
              env.MEMORY_MAINTENANCE_QUEUE.send(message).catch(() => {
                console.warn("Lore maintenance queue notification failed; sweep will retry");
              }),
            );
          },
          notifyMany(messages) {
            // Queues accept at most 100 messages per sendBatch, as the sweep sends them.
            for (let offset = 0; offset < messages.length; offset += 100) {
              context.waitUntil(
                env.MEMORY_MAINTENANCE_QUEUE.sendBatch(
                  messages.slice(offset, offset + 100).map((body) => ({ body })),
                ).catch(() => {
                  console.warn("Lore maintenance queue notification failed; sweep will retry");
                }),
              );
            }
          },
        },
      }),
    // Workers do not run local Git ingestion. Public enqueue is self-host only.
    codeRepositories: () => configuredCodeRepositoriesFromEnvironment({}),
  });
  try {
    return await app.fetch(request);
  } finally {
    if (database) context.waitUntil(database.close());
  }
}
