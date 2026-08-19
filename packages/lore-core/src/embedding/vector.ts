export function embeddingVectorLiteral(vector: number[], dimensions: number): string {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding provider returned an invalid vector");
  }
  return `[${vector.join(",")}]`;
}

export function embeddingVectorLiterals(
  vectors: number[][],
  expectedCount: number,
  dimensions: number,
): string[] {
  if (vectors.length !== expectedCount) {
    throw new Error("Embedding provider returned the wrong number of vectors");
  }
  return vectors.map((vector) => embeddingVectorLiteral(vector, dimensions));
}
