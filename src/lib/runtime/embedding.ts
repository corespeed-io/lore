import "server-only";
import { createGoogleEmbeddingProvider } from "../embedding/google";
import { createOllamaEmbeddingProvider } from "../embedding/ollama";
import { createOpenAIEmbeddingProvider } from "../embedding/openai";
import { embeddingConfigurationFromEnvironment } from "../embedding-config";
import type { EmbeddingProvider, MemoryModuleOptions } from "../memory";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function keepAlive(value: string | undefined): string | number {
  if (value === undefined || value === "") return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

export function getRuntimeEmbeddingProvider(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProvider {
  const configuration = embeddingConfigurationFromEnvironment(env);
  const timeoutMs = positiveInteger(env.LORE_EMBEDDING_TIMEOUT_MS, 120_000);
  switch (configuration.provider) {
    case "google":
      return createGoogleEmbeddingProvider(configuration, {
        apiKey: env.GEMINI_API_KEY ?? "",
        timeoutMs,
      });
    case "ollama":
      return createOllamaEmbeddingProvider(configuration, {
        baseUrl: env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
        keepAlive: keepAlive(env.OLLAMA_KEEP_ALIVE),
        timeoutMs,
      });
    case "openai":
      return createOpenAIEmbeddingProvider(configuration, {
        apiKey: env.OPENAI_API_KEY ?? "",
        timeoutMs,
      });
  }
}

export function getRuntimeMemoryModuleOptions(): MemoryModuleOptions {
  return { embeddingProvider: getRuntimeEmbeddingProvider() };
}
