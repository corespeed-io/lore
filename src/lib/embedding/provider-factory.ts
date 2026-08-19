import type { EmbeddingProvider } from "@corespeed/lore-core";
import {
  embeddingBuildEnvironment,
  embeddingConfigurationFromEnvironment,
} from "@corespeed/lore-core";
import {
  createGoogleEmbeddingProvider,
  createOllamaEmbeddingProvider,
  createOpenAIEmbeddingProvider,
} from "@corespeed/lore-core/providers";
import { markDependencyFailure, markDependencySuccess } from "../telemetry";

export type EmbeddingConfigurationWarning = (message: string) => void;

function warnOnEmbeddingFailure(
  provider: EmbeddingProvider,
  warn: EmbeddingConfigurationWarning,
): EmbeddingProvider {
  return {
    ...provider,
    async embed(texts, task) {
      try {
        const vectors = await provider.embed(texts, task);
        markDependencySuccess("embedding");
        return vectors;
      } catch (error) {
        markDependencyFailure("embedding");
        warn(
          `Lore ${provider.provider}/${provider.model} ${task} embedding failed; continuing without a vector`,
        );
        throw error;
      }
    },
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function keepAlive(value: string | undefined): string | number {
  if (value === undefined || value === "") return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

export function createEmbeddingProviderFromEnvironment(
  env: Record<string, string | undefined>,
  warn: EmbeddingConfigurationWarning = () => undefined,
): EmbeddingProvider | undefined {
  try {
    const configuration = embeddingConfigurationFromEnvironment(env);
    const timeoutMs = positiveInteger(env.LORE_EMBEDDING_TIMEOUT_MS, 120_000);
    switch (configuration.provider) {
      case "google":
        return warnOnEmbeddingFailure(
          createGoogleEmbeddingProvider(configuration, {
            apiKey: env.GEMINI_API_KEY ?? "",
            timeoutMs,
          }),
          warn,
        );
      case "ollama":
        return warnOnEmbeddingFailure(
          createOllamaEmbeddingProvider(configuration, {
            baseUrl: env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
            keepAlive: keepAlive(env.OLLAMA_KEEP_ALIVE),
            timeoutMs,
          }),
          warn,
        );
      case "openai":
        return warnOnEmbeddingFailure(
          createOpenAIEmbeddingProvider(configuration, {
            apiKey: env.OPENAI_API_KEY ?? "",
            timeoutMs,
          }),
          warn,
        );
    }
  } catch (error) {
    markDependencyFailure("embedding");
    const detail = error instanceof Error ? error.message : "unknown configuration error";
    warn(`Lore embeddings disabled: ${detail}`);
    return undefined;
  }
}

function embeddingProviderIdentity(provider: EmbeddingProvider): string {
  return [provider.provider, provider.model, provider.dimensions, provider.revision].join("\u0000");
}

export function createMaintenanceEmbeddingProvidersFromEnvironment(
  env: Record<string, string | undefined>,
  warn: EmbeddingConfigurationWarning = () => undefined,
): EmbeddingProvider[] {
  const providers: EmbeddingProvider[] = [];
  const serving = createEmbeddingProviderFromEnvironment(env, warn);
  if (serving) providers.push(serving);

  let buildEnvironment: Record<string, string | undefined> | undefined;
  try {
    buildEnvironment = embeddingBuildEnvironment(env);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown configuration error";
    warn(`Lore embedding build disabled: ${detail}`);
  }
  if (buildEnvironment) {
    const building = createEmbeddingProviderFromEnvironment(buildEnvironment, warn);
    if (building) providers.push(building);
  }

  const uniqueProviders = new Map<string, EmbeddingProvider>();
  for (const provider of providers) {
    uniqueProviders.set(embeddingProviderIdentity(provider), provider);
  }
  return [...uniqueProviders.values()];
}
