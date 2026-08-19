export const EMBEDDING_PROTOCOL_REVISION = "lore-embedding-v1";
export const QWEN3_EMBEDDING_PROTOCOL_REVISION = "lore-embedding-v2";

export type EmbeddingProviderName = "google" | "ollama" | "openai";

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
  if (provider !== "google" && provider !== "ollama" && provider !== "openai") {
    throw new Error(`Unsupported embedding provider: ${provider}`);
  }
  return provider;
}

/** Validate a deployment's embedding dimension invariant. */
export function validatedEmbeddingDimensions(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16_000) {
    throw new Error("Embedding dimensions must be a positive integer");
  }
  return value;
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
