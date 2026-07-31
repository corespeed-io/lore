// Retrieval metrics: pure, so they can be reasoned about independently of the
// store, and reused by any future eval. Not a .test.ts file on purpose —
// vitest only collects tests/**/*.test.ts, and a test file may not export.

export function recallAt(ranked: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 1;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((r) => top.has(r)).length / relevant.length;
}

export function precisionAt(ranked: string[], relevant: string[], k: number): number {
  if (k === 0) return 0;
  const rel = new Set(relevant);
  return ranked.slice(0, k).filter((s) => rel.has(s)).length / k;
}

// Reciprocal rank of the FIRST relevant hit: how far a user scrolls.
export function reciprocalRank(ranked: string[], relevant: string[]): number {
  const rel = new Set(relevant);
  const at = ranked.findIndex((s) => rel.has(s));
  return at === -1 ? 0 : 1 / (at + 1);
}

// Binary-gain nDCG: graded judgments would need a graded fixture.
export function ndcgAt(ranked: string[], relevant: string[], k: number): number {
  const rel = new Set(relevant);
  const dcg = ranked
    .slice(0, k)
    .reduce((sum, slug, i) => sum + (rel.has(slug) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = relevant.slice(0, k).reduce((sum, _, i) => sum + 1 / Math.log2(i + 2), 0);
  return ideal === 0 ? 1 : dcg / ideal;
}
