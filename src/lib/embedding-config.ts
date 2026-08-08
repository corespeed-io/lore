export const EMBEDDING_DIMENSIONS = 1024 as const;
export const EMBEDDING_PROTOCOL_REVISION = "lore-embedding-v1";

export type EmbeddingDimensions = typeof EMBEDDING_DIMENSIONS;
export type EmbeddingProviderName = "google" | "ollama" | "openai";

export interface EmbeddingConfiguration {
  provider: EmbeddingProviderName;
  model: string;
  dimensions: EmbeddingDimensions;
  revision: string;
}

export const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProviderName, string> = {
  google: "gemini-embedding-2",
  ollama: "qwen3-embedding:0.6b",
  openai: "text-embedding-3-small",
};

export const DEFAULT_EMBEDDING_CONFIGURATION: EmbeddingConfiguration = {
  provider: "ollama",
  model: DEFAULT_EMBEDDING_MODELS.ollama,
  dimensions: EMBEDDING_DIMENSIONS,
  revision: EMBEDDING_PROTOCOL_REVISION,
};

export function embeddingProviderName(value: string): EmbeddingProviderName {
  const provider = value.trim();
  if (provider !== "google" && provider !== "ollama" && provider !== "openai") {
    throw new Error(`Unsupported embedding provider: ${provider}`);
  }
  return provider;
}

export function embeddingConfiguration(input: {
  provider: string;
  model: string;
}): EmbeddingConfiguration {
  const provider = embeddingProviderName(input.provider);
  const rawModel = input.model.trim();
  const model = provider === "google" ? rawModel.replace(/^models\//, "") : rawModel;
  if (!model) throw new Error("Embedding model is required");
  return {
    provider,
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    revision: EMBEDDING_PROTOCOL_REVISION,
  };
}

export function embeddingConfigurationFromEnvironment(
  env: Record<string, string | undefined>,
): EmbeddingConfiguration {
  if (env.LORE_EMBEDDING_DIMENSIONS) {
    throw new Error("LORE_EMBEDDING_DIMENSIONS is not configurable; Lore v1 uses 1024");
  }
  const provider = embeddingProviderName(
    env.LORE_EMBEDDING_PROVIDER ?? DEFAULT_EMBEDDING_CONFIGURATION.provider,
  );
  return embeddingConfiguration({
    provider,
    model: env.LORE_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODELS[provider],
  });
}

export function embeddingBuildEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> | undefined {
  const provider = env.LORE_EMBEDDING_BUILD_PROVIDER?.trim();
  const model = env.LORE_EMBEDDING_BUILD_MODEL?.trim();
  if (!provider && !model) return undefined;
  if (!provider || !model) {
    throw new Error(
      "LORE_EMBEDDING_BUILD_PROVIDER and LORE_EMBEDDING_BUILD_MODEL must be set together",
    );
  }
  return {
    ...env,
    LORE_EMBEDDING_PROVIDER: provider,
    LORE_EMBEDDING_MODEL: model,
  };
}
