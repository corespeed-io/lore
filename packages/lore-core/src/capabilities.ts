/**
 * Host-supplied model capabilities. The engine declares the contracts; concrete
 * adapters, SDKs, defaults, and environment parsing belong to the host.
 */

/**
 * Identity and dimensions describe one vector space; the engine uses them to
 * keep incompatible generations apart. Model selection and query/document
 * preprocessing belong to the host adapter.
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

export interface RerankDocument {
  id: string;
  text: string;
}

export interface RerankResult {
  documentId: string;
  score: number;
}

/**
 * Score only the authorized evidence passages selected by the engine.
 *
 * Return exactly one result per document, each with a finite relevance score
 * in `[0, 1]`; a missing, duplicate, foreign, or out-of-range result makes the
 * engine fall back to its deterministic first-stage order. Array order carries
 * no meaning: the engine ranks by score with a stable sort, so equal scores
 * keep the order the provider returned them in.
 */
export interface RerankingProvider {
  rerank(input: {
    query: string;
    documents: RerankDocument[];
    limit: number;
  }): Promise<RerankResult[]>;
}

/** Expand a question without accessing Memory content or changing authorization. */
export interface QueryPlanningProvider {
  plan(input: { query: string; maxQueries: number }): Promise<string[]>;
}
