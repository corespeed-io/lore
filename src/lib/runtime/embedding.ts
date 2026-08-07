import "server-only";
import { createEmbeddingProviderFromEnvironment } from "../embedding/provider-factory";
import type { EmbeddingProvider, MemoryMaintenanceNotifier, MemoryModuleOptions } from "../memory";

let runtimeEmbeddingProvider: EmbeddingProvider | undefined;
let runtimeEmbeddingProviderInitialized = false;

export function getRuntimeEmbeddingProvider(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProvider | undefined {
  if (env !== process.env) {
    return createEmbeddingProviderFromEnvironment(env, (message) => console.warn(message));
  }
  if (!runtimeEmbeddingProviderInitialized) {
    runtimeEmbeddingProvider = createEmbeddingProviderFromEnvironment(process.env, (message) =>
      console.warn(message),
    );
    runtimeEmbeddingProviderInitialized = true;
  }
  return runtimeEmbeddingProvider;
}

async function getCloudflareMaintenanceNotifier(): Promise<MemoryMaintenanceNotifier | undefined> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const context = await getCloudflareContext({ async: true });
    const queue = context.env.MEMORY_MAINTENANCE_QUEUE;
    if (!queue) return undefined;
    return {
      notify(message) {
        context.ctx.waitUntil(
          queue
            .send(message)
            .catch(() =>
              console.warn("Lore maintenance queue notification failed; sweep will retry"),
            ),
        );
      },
    };
  } catch {
    // The Node/Docker worker polls the durable job table directly.
    return undefined;
  }
}

export async function getRuntimeMemoryModuleOptions(): Promise<MemoryModuleOptions> {
  return {
    embeddingProvider: getRuntimeEmbeddingProvider(),
    maintenanceNotifier: await getCloudflareMaintenanceNotifier(),
  };
}
