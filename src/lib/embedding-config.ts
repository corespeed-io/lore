import {
  DEFAULT_EMBEDDING_MODELS,
  type EmbeddingConfiguration,
  embeddingConfiguration,
  embeddingProviderName,
  QWEN3_EMBEDDING_PROTOCOL_REVISION,
} from "@corespeed/lore-core";

/**
 * lore oss's embedding-space policy. The engine treats dimensions as a
 * host-baked deployment invariant; this host pins 1024 — a Lore v1 protocol
 * invariant matching the baseline schema's vector columns, CHECKs, and HNSW
 * indexes — and refuses to read a dimension from the environment.
 */
export const EMBEDDING_DIMENSIONS = 1024 as const;

export type EmbeddingDimensions = typeof EMBEDDING_DIMENSIONS;

export const DEFAULT_EMBEDDING_CONFIGURATION: EmbeddingConfiguration = {
  provider: "ollama",
  model: DEFAULT_EMBEDDING_MODELS.ollama,
  dimensions: EMBEDDING_DIMENSIONS,
  revision: QWEN3_EMBEDDING_PROTOCOL_REVISION,
};

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
    dimensions: EMBEDDING_DIMENSIONS,
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
