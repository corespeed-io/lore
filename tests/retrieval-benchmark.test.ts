import { expect, test } from "vitest";
import {
  aggregateRetrievalBenchmark,
  evaluateRetrievalBenchmarkCase,
  type RetrievalBenchmarkCaseMetrics,
} from "@/lib/retrieval-benchmark";

test("positive retrieval cases report ranking quality and latency", () => {
  const metrics = evaluateRetrievalBenchmarkCase({
    retrievedMemoryIds: ["miss", "relevant-b", "relevant-a"],
    expectedMemoryIds: ["relevant-a", "relevant-b"],
    forbiddenMemoryIds: ["private"],
    limit: 3,
    latencyMs: 12.5,
  });

  expect(metrics).toEqual({
    recallAtOne: 0,
    recallAtK: 1,
    reciprocalRank: 1 / 2,
    ndcgAtK: (1 / Math.log2(3) + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3)),
    noAnswerCorrect: null,
    falseResultCount: 0,
    isolationPassed: true,
    forbiddenRetrievedIds: [],
    latencyMs: 12.5,
  });
});

test("no-answer cases measure abstention instead of ranking quality", () => {
  expect(
    evaluateRetrievalBenchmarkCase({
      retrievedMemoryIds: [],
      expectedMemoryIds: [],
      limit: 5,
      latencyMs: 2,
    }),
  ).toMatchObject({
    recallAtOne: 0,
    recallAtK: 0,
    noAnswerCorrect: true,
    falseResultCount: 0,
  });
  expect(
    evaluateRetrievalBenchmarkCase({
      retrievedMemoryIds: ["false-a", "false-b"],
      expectedMemoryIds: [],
      limit: 5,
      latencyMs: 3,
    }),
  ).toMatchObject({
    noAnswerCorrect: false,
    falseResultCount: 2,
  });
});

test("isolation checks every returned id even beyond ranking K", () => {
  expect(
    evaluateRetrievalBenchmarkCase({
      retrievedMemoryIds: ["expected", "private-leak"],
      expectedMemoryIds: ["expected"],
      forbiddenMemoryIds: ["private-leak"],
      limit: 1,
      latencyMs: 1,
    }),
  ).toMatchObject({
    recallAtK: 1,
    isolationPassed: false,
    forbiddenRetrievedIds: ["private-leak"],
  });
});

test("aggregate metrics separate positive and no-answer cases", () => {
  const result = (overrides: Partial<RetrievalBenchmarkCaseMetrics>) => ({
    recallAtOne: 1,
    recallAtK: 1,
    reciprocalRank: 1,
    ndcgAtK: 1,
    noAnswerCorrect: null,
    falseResultCount: 0,
    isolationPassed: true,
    forbiddenRetrievedIds: [],
    latencyMs: 1,
    ...overrides,
  });
  const metrics = aggregateRetrievalBenchmark([
    result({ latencyMs: 1 }),
    result({ recallAtOne: 0, recallAtK: 0.5, reciprocalRank: 0.5, latencyMs: 2 }),
    result({ noAnswerCorrect: true, latencyMs: 3 }),
    result({
      noAnswerCorrect: false,
      falseResultCount: 2,
      isolationPassed: false,
      forbiddenRetrievedIds: ["private-leak"],
      latencyMs: 100,
    }),
  ]);

  expect(metrics).toEqual({
    positiveCaseCount: 2,
    noAnswerCaseCount: 2,
    recallAtOne: 0.5,
    recallAtK: 0.75,
    reciprocalRank: 0.75,
    ndcgAtK: 1,
    noAnswerAccuracy: 0.5,
    averageFalseResults: 1,
    isolationPassed: false,
    hardFailureCount: 1,
    averageLatencyMs: 26.5,
    p50LatencyMs: 2,
    p95LatencyMs: 100,
  });
});
