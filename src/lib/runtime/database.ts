import "server-only";
import type { RuntimeLoreDatabase } from "../db/drizzle";
import { createDrizzleDatabase, createRequestDrizzleDatabase } from "../db/drizzle";

interface HyperdriveBinding {
  connectionString: string;
}

let nodeDatabase: RuntimeLoreDatabase | null = null;

async function resolveCloudflareDatabase(): Promise<RuntimeLoreDatabase | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const context = await getCloudflareContext({ async: true });
    const hyperdrive = (context.env as unknown as { HYPERDRIVE?: HyperdriveBinding }).HYPERDRIVE;
    return hyperdrive?.connectionString
      ? createRequestDrizzleDatabase({ connectionString: hyperdrive.connectionString })
      : null;
  } catch {
    // Standard Node/Docker execution has no OpenNext request context.
    return null;
  }
}

export async function getRuntimeDatabase(): Promise<RuntimeLoreDatabase> {
  if (nodeDatabase) return nodeDatabase;
  const cloudflareDatabase = await resolveCloudflareDatabase();
  if (cloudflareDatabase) return cloudflareDatabase;
  if (process.env.DATABASE_URL) {
    nodeDatabase = createDrizzleDatabase({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_SIZE ?? "10"),
    });
    return nodeDatabase;
  }
  throw new Error("DATABASE_URL or the Cloudflare HYPERDRIVE binding is required");
}
