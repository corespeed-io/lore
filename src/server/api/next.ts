import "server-only";
import { handle } from "hono/vercel";
import { configuredCodeRepositoriesFromEnvironment } from "@/modules/code/indexing/queue";
import { createPostgresDatabase, type RuntimePostgresDatabase } from "@/server/database/postgres";
import { getRuntimeMemoryModuleOptions } from "@/server/providers/runtime";
import { createApi } from "./app";

let database: RuntimePostgresDatabase | undefined;
const handler = handle(
  createApi({
    database() {
      if (!database) {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
        database = createPostgresDatabase({
          connectionString: process.env.DATABASE_URL,
          max: Number(process.env.DATABASE_POOL_SIZE ?? "10"),
        });
      }
      return database;
    },
    memoryOptions: () => getRuntimeMemoryModuleOptions(),
    codeRepositories: () => configuredCodeRepositoriesFromEnvironment(process.env),
  }),
);

export async function handleNextApi(request: Request): Promise<Response> {
  // Preserve the opt-in local Hyperdrive development profile. Production Workers
  // dispatch directly to Hono in worker.ts, outside OpenNext.
  if (
    process.env.NODE_ENV === "development" &&
    process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
  ) {
    const [{ getCloudflareContext }, { fetchCloudflareApi }] = await Promise.all([
      import("@opennextjs/cloudflare"),
      import("./cloudflare"),
    ]);
    const { env, ctx } = await getCloudflareContext({ async: true });
    return fetchCloudflareApi(request, env, ctx);
  }
  return handler(request);
}
