import type { MemorySearchResult } from "../memory-types";
import { RETRIEVAL_FEEDBACK_CANDIDATE_POLICY } from "./policy";
import { evidenceTerms } from "./query";

export const rerankEvidence = Symbol("lore.rerankEvidence");

export type InternalMemorySearchResult = MemorySearchResult & {
  [rerankEvidence]: string;
};

export function compactRerankEvidence(result: MemorySearchResult): string {
  return (result as Partial<InternalMemorySearchResult>)[rerankEvidence] ?? result.evidence;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const term of left) {
    if (right.has(term)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

export function diversifyRerankedResults(
  results: MemorySearchResult[],
  limit: number,
  lambda: number,
): MemorySearchResult[] {
  if (lambda >= 1 || results.length <= 1) return results.slice(0, limit);
  const remaining = results.map((result, index) => ({
    result,
    index,
    terms: evidenceTerms(result.evidence),
  }));
  const selected: typeof remaining = [];
  while (selected.length < limit && remaining.length) {
    let bestIndex = 0;
    let bestObjective = Number.NEGATIVE_INFINITY;
    for (const [index, candidate] of remaining.entries()) {
      const maximumSimilarity = selected.length
        ? Math.max(...selected.map((item) => jaccard(candidate.terms, item.terms)))
        : 0;
      const relevance = (results.length - candidate.index) / results.length;
      const objective = lambda * relevance - (1 - lambda) * maximumSimilarity;
      // remaining stays in rank order, so a strict comparison keeps the
      // better-ranked candidate on a tie.
      if (objective > bestObjective) {
        bestObjective = objective;
        bestIndex = index;
      }
    }
    selected.push(...remaining.splice(bestIndex, 1));
  }
  return selected.map((item) => item.result);
}

export function fuseRerankedResults(
  fusionResults: MemorySearchResult[],
  rerankedResults: MemorySearchResult[],
  weight: number,
): MemorySearchResult[] {
  if (weight >= 1) return rerankedResults;
  const fusionRankById = new Map(
    fusionResults.map((result, index) => [result.memory.id, index + 1] as const),
  );
  return rerankedResults
    .map((result, index) => {
      const rerankRank = index + 1;
      const fusionRank = fusionRankById.get(result.memory.id);
      if (fusionRank === undefined) throw new Error("Reranking result escaped the candidate pool");
      return {
        ...result,
        score: weight / (60 + rerankRank) + (1 - weight) / (60 + fusionRank),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        (fusionRankById.get(left.memory.id) ?? 0) - (fusionRankById.get(right.memory.id) ?? 0),
    );
}

export function fuseQueryResults(
  resultSets: MemorySearchResult[][],
  limit: number,
): MemorySearchResult[] {
  if (resultSets.length === 1) return (resultSets[0] ?? []).slice(0, limit);
  const fused = new Map<
    string,
    { result: MemorySearchResult; score: number; bestRank: number; firstQuery: number }
  >();
  for (const [queryIndex, results] of resultSets.entries()) {
    for (const [resultIndex, result] of results.entries()) {
      const rank = resultIndex + 1;
      const existing = fused.get(result.memory.id);
      const score = 1 / (60 + rank);
      if (!existing) {
        fused.set(result.memory.id, {
          result,
          score,
          bestRank: rank,
          firstQuery: queryIndex,
        });
        continue;
      }
      existing.score += score;
      if (rank < existing.bestRank) {
        existing.result = result;
        existing.bestRank = rank;
        existing.firstQuery = queryIndex;
      }
    }
  }
  return [...fused.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.bestRank - right.bestRank ||
        left.firstQuery - right.firstQuery ||
        left.result.memory.id.localeCompare(right.result.memory.id),
    )
    .slice(0, limit)
    .map(({ result, score }) => ({ ...result, score }));
}

/**
 * Merge retrieval-feedback candidates into the fixed first pass.
 *
 * `firstPassResults` is the original fused pool, never a previous merge.
 * `feedbackResults` holds every round's candidates in discovery order, so the
 * earliest novel feedback keeps its slot and later rounds only fill what the
 * shared reserve has left. A full pool keeps its leading first-pass share and
 * gives feedback at most the trailing reserve; free slots below the budget
 * also go to feedback. The result never exceeds `limit`.
 */
export function appendFeedbackResults(
  firstPassResults: MemorySearchResult[],
  feedbackResults: MemorySearchResult[],
  limit: number,
): MemorySearchResult[] {
  const firstPass = firstPassResults.slice(0, limit);
  if (limit <= 1) return firstPass;
  const selectedIds = new Set(firstPass.map((result) => result.memory.id));
  const novelFeedback: MemorySearchResult[] = [];
  for (const result of feedbackResults) {
    if (selectedIds.has(result.memory.id)) continue;
    selectedIds.add(result.memory.id);
    novelFeedback.push(result);
  }
  if (!novelFeedback.length) return firstPass;

  const reservedFeedbackSlots = Math.max(
    RETRIEVAL_FEEDBACK_CANDIDATE_POLICY.minimumSlots,
    Math.floor(limit * RETRIEVAL_FEEDBACK_CANDIDATE_POLICY.targetShare),
  );
  const feedbackSlots = Math.min(
    novelFeedback.length,
    Math.max(limit - firstPass.length, reservedFeedbackSlots),
  );
  return [...firstPass.slice(0, limit - feedbackSlots), ...novelFeedback.slice(0, feedbackSlots)];
}

export function fuseRecencyResults(
  results: MemorySearchResult[],
  weight: number,
): MemorySearchResult[] {
  if (weight <= 0 || results.length <= 1) return results;
  const recencyRankById = new Map(
    [...results]
      .sort(
        (left, right) =>
          Date.parse(right.memory.updatedAt) - Date.parse(left.memory.updatedAt) ||
          left.memory.id.localeCompare(right.memory.id),
      )
      .map((result, index) => [result.memory.id, index + 1] as const),
  );
  // results arrive in relevance order and the sort is stable, so equal scores
  // keep their relevance order.
  return results
    .map((result, index) => {
      const recencyRank = recencyRankById.get(result.memory.id) ?? results.length;
      return {
        ...result,
        score: (1 - weight) / (60 + index + 1) + weight / (60 + recencyRank),
      };
    })
    .sort((left, right) => right.score - left.score);
}
