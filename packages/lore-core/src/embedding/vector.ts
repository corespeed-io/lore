import { EMBEDDING_DIMENSIONS } from "../embedding-config";

export function embeddingVectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding provider returned an invalid vector");
  }
  return `[${vector.join(",")}]`;
}

export function embeddingVectorLiterals(vectors: number[][], expectedCount: number): string[] {
  if (vectors.length !== expectedCount) {
    throw new Error("Embedding provider returned the wrong number of vectors");
  }
  return vectors.map(embeddingVectorLiteral);
}
