import { configuredCodeRepositoriesFromEnvironment } from "@/modules/code/indexing/queue";
import { createRequestPostgresDatabase } from "@/server/database/postgres";
import { getRuntimeMemoryModuleOptions } from "@/server/providers/runtime";
import { createApi } from "./app";

/** Each request gets its own Hyperdrive adapter; sockets never cross request lifetimes. */
export function fetchCloudflareApi(
  request: Request,
  env: Pick<CloudflareEnv, "HYPERDRIVE" | "MEMORY_MAINTENANCE_QUEUE">,
  context: Pick<ExecutionContext, "waitUntil">,
) {
  const app = createApi({
    database: () =>
      createRequestPostgresDatabase({ connectionString: env.HYPERDRIVE.connectionString }),
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
  return app.fetch(request);
}
