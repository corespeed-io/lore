import "server-only";
import type { RuntimePostgresDatabase } from "../db/postgres";
import { createPostgresDatabase, createRequestPostgresDatabase } from "../db/postgres";

interface HyperdriveBinding {
  connectionString: string;
}

let nodeDatabase: RuntimePostgresDatabase | null = null;

async function resolveCloudflareDatabase(): Promise<RuntimePostgresDatabase | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const context = await getCloudflareContext({ async: true });
    const hyperdrive = (context.env as unknown as { HYPERDRIVE?: HyperdriveBinding }).HYPERDRIVE;
    return hyperdrive?.connectionString
      ? createRequestPostgresDatabase({ connectionString: hyperdrive.connectionString })
      : null;
  } catch {
    // Standard Node/Docker execution has no OpenNext request context.
    return null;
  }
}

export async function getRuntimeDatabase(): Promise<RuntimePostgresDatabase> {
  if (nodeDatabase) return nodeDatabase;
  const cloudflareDatabase = await resolveCloudflareDatabase();
  if (cloudflareDatabase) return cloudflareDatabase;
  if (process.env.DATABASE_URL) {
    nodeDatabase = createPostgresDatabase({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_SIZE ?? "10"),
    });
    return nodeDatabase;
  }
  throw new Error("DATABASE_URL or the Cloudflare HYPERDRIVE binding is required");
}
