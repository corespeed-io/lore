import "server-only";
import { createEmbeddingProviderFromEnvironment } from "../embedding/provider-factory";
import type { EmbeddingProvider, MemoryModuleOptions } from "../memory";

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

export function getRuntimeMemoryModuleOptions(): MemoryModuleOptions {
  return { embeddingProvider: getRuntimeEmbeddingProvider() };
}
