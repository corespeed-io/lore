/**
 * Host-supplied embedding capability. Identity and dimensions describe one
 * vector space; the engine uses them to keep incompatible generations apart.
 * Model selection and query/document preprocessing belong to the host adapter.
 */
export interface EmbeddingProvider {
  provider: string;
  model: string;
  dimensions: number;
  revision: string;
  embed(texts: string[], task: EmbeddingTask): Promise<number[][]>;
}

export type EmbeddingTask = "document" | "query";

/** Validate a deployment's embedding dimension invariant. */
export function validatedEmbeddingDimensions(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16_000) {
    throw new Error("Embedding dimensions must be a positive integer");
  }
  return value;
}
