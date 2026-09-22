import { validatedEmbeddingDimensions } from "@corespeed/lore-core";

export const EMBEDDING_PROTOCOL_REVISION = "lore-embedding-v1";
export const QWEN3_EMBEDDING_PROTOCOL_REVISION = "lore-embedding-v2";

export type EmbeddingProviderName = "google" | "ollama" | "openai" | "vercel";

/**
 * One deployment's embedding space. `dimensions` is a host-baked schema
 * invariant (vector column width, CHECK constraint, HNSW index width), never a
 * runtime knob: the engine validates and enforces it but only the host's own
 * migrations may choose it. lore oss pins 1024; other hosts pin their own.
 */
export interface EmbeddingConfiguration {
  provider: EmbeddingProviderName;
  model: string;
  dimensions: number;
  revision: string;
}

export const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProviderName, string> = {
  google: "gemini-embedding-2",
  ollama: "qwen3-embedding:0.6b",
  openai: "text-embedding-3-small",
  vercel: "openai/text-embedding-3-small",
};

export function isQwen3EmbeddingModel(model: string): boolean {
  return /qwen3-embedding(?:[:/_-]|$)/iu.test(model);
}

export function embeddingProtocolRevision(provider: EmbeddingProviderName, model: string): string {
  return provider === "ollama" && isQwen3EmbeddingModel(model)
    ? QWEN3_EMBEDDING_PROTOCOL_REVISION
    : EMBEDDING_PROTOCOL_REVISION;
}

export function embeddingProviderName(value: string): EmbeddingProviderName {
  const provider = value.trim();
  if (
    provider !== "google" &&
    provider !== "ollama" &&
    provider !== "openai" &&
    provider !== "vercel"
  ) {
    throw new Error(`Unsupported embedding provider: ${provider}`);
  }
  return provider;
}

export function embeddingConfiguration(input: {
  provider: string;
  model: string;
  dimensions: number;
}): EmbeddingConfiguration {
  const provider = embeddingProviderName(input.provider);
  const rawModel = input.model.trim();
  const model = provider === "google" ? rawModel.replace(/^models\//, "") : rawModel;
  if (!model) throw new Error("Embedding model is required");
  return {
    provider,
    model,
    dimensions: validatedEmbeddingDimensions(input.dimensions),
    revision: embeddingProtocolRevision(provider, model),
  };
}

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
