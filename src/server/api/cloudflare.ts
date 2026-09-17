import { configuredCodeRepositoriesFromEnvironment } from "@/modules/code/indexing/queue";
import { createRequestPostgresDatabase } from "@/server/database/postgres";
import { getRuntimeMemoryModuleOptions } from "@/server/providers/runtime";
import { createApi } from "./app";

/** Each request gets its own Hyperdrive adapter; sockets never cross request lifetimes. */
export function fetchCloudflareApi(
  request: Request,
  env: CloudflareEnv,
  context: ExecutionContext,
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
        },
      }),
    // Workers do not run local Git ingestion. Public enqueue is self-host only.
    codeRepositories: () => configuredCodeRepositoriesFromEnvironment({}),
  });
  return app.fetch(request);
}
