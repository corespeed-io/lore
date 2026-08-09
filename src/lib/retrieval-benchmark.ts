import { evaluateRanking } from "./evaluation";

export type RetrievalBenchmarkActor = "alice" | "bob";

export interface RetrievalBenchmarkMemoryFixture {
  key: string;
  owner: RetrievalBenchmarkActor;
  scope: "shared" | "private";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RetrievalBenchmarkCaseFixture {
  key: string;
  actor?: RetrievalBenchmarkActor;
  category?: string;
  query: string;
  expectedKeys: string[];
  forbiddenKeys?: string[];
  limit: number;
}

/**
 * A partition is the complete visible history for one or more benchmark cases.
 * The runner installs every partition in its own Workspace so external suites
 * cannot leak unrelated histories into one another's candidate set.
 */
export interface RetrievalBenchmarkPartition {
  key: string;
  name: string;
  memories: RetrievalBenchmarkMemoryFixture[];
  cases: RetrievalBenchmarkCaseFixture[];
}

export interface RetrievalBenchmarkSuiteSource {
  name: string;
  version: string | number;
  description: string;
  thresholds: number[];
  provenance?: Record<string, unknown>;
  partitions: AsyncIterable<RetrievalBenchmarkPartition>;
}

export interface RetrievalBenchmarkCaseMeasurement {
  retrievedMemoryIds: string[];
  expectedMemoryIds: string[];
  forbiddenMemoryIds?: string[];
  limit: number;
  latencyMs: number;
}

export interface RetrievalBenchmarkCaseMetrics {
  recallAtOne: number;
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  noAnswerCorrect: boolean | null;
  falseResultCount: number;
  isolationPassed: boolean;
  forbiddenRetrievedIds: string[];
  latencyMs: number;
}

export interface RetrievalBenchmarkMetrics {
  positiveCaseCount: number;
  noAnswerCaseCount: number;
  recallAtOne: number;
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  noAnswerAccuracy: number;
  averageFalseResults: number;
  isolationPassed: boolean;
  hardFailureCount: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function mean(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(Math.min(1, Math.max(0, fraction)) * sorted.length));
  return sorted[rank - 1];
}

export function evaluateRetrievalBenchmarkCase(
  measurement: RetrievalBenchmarkCaseMeasurement,
): RetrievalBenchmarkCaseMetrics {
  const retrievedMemoryIds = unique(measurement.retrievedMemoryIds);
  const expectedMemoryIds = unique(measurement.expectedMemoryIds);
  const ranking = evaluateRanking({
    retrievedMemoryIds,
    expectedMemoryIds,
    forbiddenMemoryIds: measurement.forbiddenMemoryIds,
    limit: measurement.limit,
  });
  const isNoAnswer = expectedMemoryIds.length === 0;
  const firstRetrieved = retrievedMemoryIds[0];
  return {
    recallAtOne: isNoAnswer
      ? 0
      : expectedMemoryIds.filter((id) => id === firstRetrieved).length / expectedMemoryIds.length,
    recallAtK: ranking.recallAtK,
    reciprocalRank: ranking.reciprocalRank,
    ndcgAtK: ranking.ndcgAtK,
    noAnswerCorrect: isNoAnswer ? retrievedMemoryIds.length === 0 : null,
    falseResultCount: isNoAnswer ? retrievedMemoryIds.length : 0,
    isolationPassed: ranking.isolationPassed,
    forbiddenRetrievedIds: ranking.forbiddenRetrievedIds,
    latencyMs: Math.max(0, measurement.latencyMs),
  };
}

export function aggregateRetrievalBenchmark(
  cases: RetrievalBenchmarkCaseMetrics[],
): RetrievalBenchmarkMetrics {
  const positiveCases = cases.filter((result) => result.noAnswerCorrect === null);
  const noAnswerCases = cases.filter(
    (result): result is RetrievalBenchmarkCaseMetrics & { noAnswerCorrect: boolean } =>
      result.noAnswerCorrect !== null,
  );
  const hardFailureCount = cases.filter((result) => !result.isolationPassed).length;
  const latencies = cases.map((result) => result.latencyMs);
  return {
    positiveCaseCount: positiveCases.length,
    noAnswerCaseCount: noAnswerCases.length,
    recallAtOne: mean(positiveCases.map((result) => result.recallAtOne)),
    recallAtK: mean(positiveCases.map((result) => result.recallAtK)),
    reciprocalRank: mean(positiveCases.map((result) => result.reciprocalRank)),
    ndcgAtK: mean(positiveCases.map((result) => result.ndcgAtK)),
    noAnswerAccuracy: mean(noAnswerCases.map((result) => (result.noAnswerCorrect ? 1 : 0))),
    averageFalseResults: mean(noAnswerCases.map((result) => result.falseResultCount)),
    isolationPassed: hardFailureCount === 0,
    hardFailureCount,
    averageLatencyMs: mean(latencies),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
  };
}
