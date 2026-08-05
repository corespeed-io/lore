import { expect, test } from "vitest";
import { installActorContext } from "@/lib/actor-context";
import {
  createEvaluationModule,
  type EvaluationSearchProvider,
  evaluateRanking,
} from "@/lib/evaluation";
import { createMemoryModule } from "@/lib/memory";
import syntheticSuite from "../evaluation/suites/synthetic-v1.json";
import { createMemoryTestContext } from "./support/memory-context";

test("Ranking metrics calculate Recall@K, MRR, and nDCG deterministically", () => {
  expect(
    evaluateRanking({
      retrievedMemoryIds: ["miss", "relevant-b", "relevant-a"],
      expectedMemoryIds: ["relevant-a", "relevant-b", "relevant-c"],
      forbiddenMemoryIds: ["hidden"],
      limit: 3,
    }),
  ).toEqual({
    recallAtK: 2 / 3,
    reciprocalRank: 1 / 2,
    ndcgAtK: (1 / Math.log2(3) + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3) + 1 / Math.log2(4)),
    isolationPassed: true,
    forbiddenRetrievedIds: [],
  });
});

test("Isolation scans every retrieved id even beyond ranking K", () => {
  expect(
    evaluateRanking({
      retrievedMemoryIds: ["expected-a", "expected-b", "private-leak"],
      expectedMemoryIds: ["expected-a", "expected-b"],
      forbiddenMemoryIds: ["private-leak"],
      limit: 2,
    }),
  ).toMatchObject({
    recallAtK: 1,
    isolationPassed: false,
    forbiddenRetrievedIds: ["private-leak"],
  });
});

test("Evaluation run persists repeatable metrics without retrieving private neighbors", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  let clock = 0;
  const evaluations = createEvaluationModule(testContext.database, {
    now: () => {
      clock += 4;
      return clock;
    },
    estimateCostUsd: ({ retrievedCount }) => retrievedCount * 0.001,
  });
  const memoryIds = new Map<string, string>();
  for (const fixture of syntheticSuite.memories) {
    const actor = fixture.owner === "alice" ? testContext.alice : testContext.bob;
    const memory = await memories.remember(actor, {
      content: fixture.content,
      scope: fixture.scope as "shared" | "private",
    });
    memoryIds.set(fixture.key, memory.id);
  }
  const relevantId = memoryIds.get("release-freeze");
  if (!relevantId) throw new Error("Synthetic expected Memory is missing");
  const suite = await evaluations.createSuite(testContext.alice, {
    name: syntheticSuite.name,
    version: syntheticSuite.version,
    cases: syntheticSuite.cases.map((evaluationCase) => ({
      query: evaluationCase.query,
      expectedMemoryIds: evaluationCase.expectedKeys.map((key) => memoryIds.get(key) ?? key),
      forbiddenMemoryIds: evaluationCase.forbiddenKeys.map((key) => memoryIds.get(key) ?? key),
      limit: evaluationCase.limit,
    })),
  });

  const run = await evaluations.runSuite(testContext.alice, suite.id);

  expect(run.status).toBe("completed");
  expect(run.metrics).toMatchObject({
    recallAtK: 1,
    reciprocalRank: 1,
    ndcgAtK: 1,
    isolationPassed: true,
    hardFailureCount: 0,
    caseCount: syntheticSuite.cases.length,
    averageLatencyMs: 4,
    estimatedCostUsd: syntheticSuite.cases.length * 0.001,
  });
  expect(run.results[0]).toMatchObject({
    retrievedMemoryIds: [relevantId],
    latencyMs: 4,
    estimatedCostUsd: 0.001,
    metrics: { isolationPassed: true, forbiddenRetrievedIds: [] },
  });
  await expect(evaluations.getSuite(testContext.carol, suite.id)).resolves.toBeNull();
  await expect(evaluations.getSuite(testContext.bob, suite.id)).resolves.toBeNull();
  await expect(evaluations.listSuites(testContext.bob)).resolves.toEqual([]);
  await expect(evaluations.getRun(testContext.bob, run.id)).resolves.toBeNull();
  await expect(evaluations.runSuite(testContext.bob, suite.id)).rejects.toBeInstanceOf(Error);
  for (const table of [
    "evaluation_suites",
    "evaluation_cases",
    "evaluation_runs",
    "evaluation_results",
  ]) {
    await testContext.database.transaction(async (transaction) => {
      await installActorContext(transaction, testContext.alice);
      const visible = await transaction.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(visible.rows[0].count)).toBeGreaterThan(0);
    });
    for (const deniedActor of [testContext.bob, testContext.carol]) {
      await testContext.database.transaction(async (transaction) => {
        await installActorContext(transaction, deniedActor);
        await expect(transaction.query(`SELECT id FROM ${table}`)).resolves.toMatchObject({
          rows: [],
        });
      });
    }
  }

  await testContext.close();
});

test("Any forbidden retrieval hard-fails the Evaluation run", async () => {
  const testContext = await createMemoryTestContext();
  const hiddenId = "40000000-0000-4000-8000-000000000001";
  const expectedId = "40000000-0000-4000-8000-000000000002";
  const maliciousSearch: EvaluationSearchProvider = {
    search: async () => [{ memory: { id: hiddenId } }, { memory: { id: expectedId } }],
  };
  const evaluations = createEvaluationModule(testContext.database, {
    searchProvider: maliciousSearch,
    now: (() => {
      let value = 100;
      return () => {
        value += 5;
        return value;
      };
    })(),
  });
  const suite = await evaluations.createSuite(testContext.alice, {
    name: "Isolation tripwire",
    cases: [
      {
        query: "secret",
        expectedMemoryIds: [expectedId],
        forbiddenMemoryIds: [hiddenId],
        limit: 2,
      },
    ],
  });

  const run = await evaluations.runSuite(testContext.alice, suite.id);

  expect(run.status).toBe("failed");
  expect(run.metrics).toMatchObject({ isolationPassed: false, hardFailureCount: 1 });
  expect(run.results[0]).toMatchObject({
    latencyMs: 5,
    metrics: { isolationPassed: false, forbiddenRetrievedIds: [hiddenId] },
  });

  await testContext.close();
});

test("A crashed Evaluation run records fail-closed isolation metrics", async () => {
  const testContext = await createMemoryTestContext();
  const evaluations = createEvaluationModule(testContext.database, {
    searchProvider: {
      async search() {
        throw new Error("provider unavailable");
      },
    },
  });
  const suite = await evaluations.createSuite(testContext.alice, {
    name: "Provider failure",
    cases: [
      {
        query: "failure",
        expectedMemoryIds: ["40000000-0000-4000-8000-000000000003"],
      },
    ],
  });

  await expect(evaluations.runSuite(testContext.alice, suite.id)).rejects.toThrow(
    "provider unavailable",
  );
  const runId = await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    const result = await transaction.query<{ id: string }>(
      "SELECT id FROM evaluation_runs WHERE suite_id = $1",
      [suite.id],
    );
    return result.rows[0].id;
  });

  await expect(evaluations.getRun(testContext.alice, runId)).resolves.toMatchObject({
    status: "failed",
    metrics: { isolationPassed: false, hardFailureCount: 1 },
  });
});
