import { expect, test } from "vitest";
import { retrievalKnobsFromEnvironment } from "../../src/server/providers/retrieval-knobs";
import type { RetrievalBenchmarkCaseMetrics } from "../../tools/evaluation/retrieval/retrieval";
import {
  aggregateRetrievalBenchmark,
  evaluateRetrievalBenchmarkCase,
} from "../../tools/evaluation/retrieval/retrieval";
import {
  candidateLimitSweep,
  entityAliasRecallOverride,
  knobOverride,
} from "../../tools/evaluation/retrieval/retrieval-suite";

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

test("no-answer accuracy is absent, not zero, when a suite has no no-answer cases", () => {
  const metrics = aggregateRetrievalBenchmark([
    evaluateRetrievalBenchmarkCase({
      retrievedMemoryIds: ["expected"],
      expectedMemoryIds: ["expected"],
      limit: 1,
      latencyMs: 1,
    }),
  ]);
  expect(metrics).toMatchObject({ positiveCaseCount: 1, noAnswerCaseCount: 0 });
  expect(metrics.noAnswerAccuracy).toBeNull();
});

test("candidate-depth sweeps accept the full deployment bound and name the right setting", () => {
  expect(candidateLimitSweep(150, {})).toEqual([150]);
  expect(candidateLimitSweep(50, { LORE_BENCHMARK_RERANK_CANDIDATE_LIMITS: "20,200,20" })).toEqual([
    20, 200,
  ]);
  expect(() => candidateLimitSweep(201, {})).toThrow(
    "The rerank candidate limit (LORE_RERANK_CANDIDATE_LIMIT) must be an integer from 1 to 200",
  );
  expect(() =>
    candidateLimitSweep(50, { LORE_BENCHMARK_RERANK_CANDIDATE_LIMITS: "20,250" }),
  ).toThrow(
    "LORE_BENCHMARK_RERANK_CANDIDATE_LIMITS must contain comma-separated integers from 1 to 200",
  );
});

test("a benchmark runs with the deployment's knobs unless a LORE_BENCHMARK_ variable overrides one", () => {
  const { knobs } = retrievalKnobsFromEnvironment({ LORE_EVIDENCE_TOP_CHUNKS: "3" });
  expect(knobOverride("LORE_BENCHMARK_EVIDENCE_TOP_CHUNKS", "evidenceTopChunks", knobs, {})).toBe(
    3,
  );
  expect(
    knobOverride("LORE_BENCHMARK_EVIDENCE_TOP_CHUNKS", "evidenceTopChunks", knobs, {
      LORE_BENCHMARK_EVIDENCE_TOP_CHUNKS: " ",
    }),
  ).toBe(3);
  expect(
    knobOverride("LORE_BENCHMARK_EVIDENCE_TOP_CHUNKS", "evidenceTopChunks", knobs, {
      LORE_BENCHMARK_EVIDENCE_TOP_CHUNKS: "5",
    }),
  ).toBe(5);
  // An override is held to the deployment bounds.
  expect(() =>
    knobOverride("LORE_BENCHMARK_EVIDENCE_TOP_CHUNKS", "evidenceTopChunks", knobs, {
      LORE_BENCHMARK_EVIDENCE_TOP_CHUNKS: "6",
    }),
  ).toThrow("LORE_BENCHMARK_EVIDENCE_TOP_CHUNKS must be an integer from 1 to 5");
  expect(() =>
    knobOverride("LORE_BENCHMARK_RETRIEVAL_RECENCY_WEIGHT", "retrievalRecencyWeight", knobs, {
      LORE_BENCHMARK_RETRIEVAL_RECENCY_WEIGHT: "1.5",
    }),
  ).toThrow("LORE_BENCHMARK_RETRIEVAL_RECENCY_WEIGHT must be a number from 0 to 1");
});

test("entity-alias recall follows the deployment unless the benchmark variable overrides it", () => {
  const off = retrievalKnobsFromEnvironment({}).knobs;
  const on = retrievalKnobsFromEnvironment({ LORE_ENTITY_ALIAS_RECALL: "true" }).knobs;
  expect(entityAliasRecallOverride(off, {})).toBe(false);
  expect(entityAliasRecallOverride(on, {})).toBe(true);
  expect(entityAliasRecallOverride(on, { LORE_BENCHMARK_ENTITY_ALIAS_RECALL: " " })).toBe(true);
  expect(entityAliasRecallOverride(off, { LORE_BENCHMARK_ENTITY_ALIAS_RECALL: "TRUE" })).toBe(true);
  expect(entityAliasRecallOverride(on, { LORE_BENCHMARK_ENTITY_ALIAS_RECALL: "0" })).toBe(false);
  expect(() =>
    entityAliasRecallOverride(off, { LORE_BENCHMARK_ENTITY_ALIAS_RECALL: "yes" }),
  ).toThrow("LORE_BENCHMARK_ENTITY_ALIAS_RECALL must be 0, 1, false, or true");
});
