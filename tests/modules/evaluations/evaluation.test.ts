import { expect, test } from "vitest";
import type { EvaluationSearchProvider } from "@/modules/evaluations/service";
import {
  createEvaluationModule,
  EVALUATION_RUN_EXPIRED_ERROR,
  evaluateRanking,
} from "@/modules/evaluations/service";
import syntheticSuite from "../../../evaluation/suites/synthetic-v1.json";
import { createMemoryModule } from "../../../src/modules/memories/service";
import { installActorContext } from "../../../src/server/auth/actor-context";
import { createMemoryTestContext } from "../../support/memory-context";

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
  await expect(evaluations.listSuites(testContext.bob)).resolves.toEqual({
    suites: [],
    nextCursor: null,
  });
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

test("Evaluation Suites list in bounded pages with their cases loaded together", async () => {
  const testContext = await createMemoryTestContext();
  const evaluations = createEvaluationModule(testContext.database);
  const expectedMemoryIds = ["40000000-0000-4000-8000-000000000009"];
  const created = [];
  for (let index = 0; index < 5; index += 1) {
    created.push(
      await evaluations.createSuite(testContext.alice, {
        name: `Paged suite ${index}`,
        cases: [
          { query: `first ${index}`, expectedMemoryIds },
          { query: `second ${index}`, expectedMemoryIds },
        ],
      }),
    );
  }

  const listed = [];
  let cursor: { id: string; updatedAt: string } | undefined;
  for (let page = 0; page < 3; page += 1) {
    const result = await evaluations.listSuites(testContext.alice, { cursor, limit: 2 });
    expect(result.suites.length).toBeLessThanOrEqual(2);
    listed.push(...result.suites);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  expect(listed.map((suite) => suite.id)).toEqual(created.map((suite) => suite.id).reverse());
  for (const suite of listed) {
    expect(suite.cases.map((evaluationCase) => evaluationCase.query)).toEqual(
      created.find((candidate) => candidate.id === suite.id)?.cases.map((item) => item.query),
    );
  }
  await expect(evaluations.listSuites(testContext.alice, { limit: 5 })).resolves.toMatchObject({
    nextCursor: null,
  });
  await expect(evaluations.listSuites(testContext.bob)).resolves.toEqual({
    suites: [],
    nextCursor: null,
  });
});

test("An abandoned running Evaluation run fails with a content-free reason on read", async () => {
  const testContext = await createMemoryTestContext();
  const evaluations = createEvaluationModule(testContext.database);
  const suite = await evaluations.createSuite(testContext.alice, {
    name: "Abandoned runs",
    cases: [{ query: "abandoned", expectedMemoryIds: ["40000000-0000-4000-8000-000000000004"] }],
  });
  const [abandonedId, liveId] = [crypto.randomUUID(), crypto.randomUUID()];
  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    await transaction.query(
      `INSERT INTO evaluation_runs (id, workspace_id, suite_id, created_by_user_id, started_at)
       VALUES ($1, $3, $4, $5, now() - interval '2 hours'),
              ($2, $3, $4, $5, now() - interval '5 minutes')`,
      [abandonedId, liveId, testContext.alice.workspaceId, suite.id, testContext.alice.userId],
    );
  });

  await expect(evaluations.getRun(testContext.bob, abandonedId)).resolves.toBeNull();
  await expect(evaluations.getRun(testContext.alice, abandonedId)).resolves.toMatchObject({
    status: "failed",
    error: EVALUATION_RUN_EXPIRED_ERROR,
    completedAt: expect.anything(),
  });
  await expect(evaluations.getRun(testContext.alice, liveId)).resolves.toMatchObject({
    status: "running",
    error: null,
    completedAt: null,
  });
});

test("A live Evaluation run stops at its deadline instead of running unbounded", async () => {
  const testContext = await createMemoryTestContext();
  let clock = 0;
  const evaluations = createEvaluationModule(testContext.database, {
    searchProvider: { search: async () => [] },
    now: () => {
      clock += 5;
      return clock;
    },
    runTimeoutSeconds: 0.01,
  });
  const expectedMemoryIds = ["40000000-0000-4000-8000-000000000005"];
  const suite = await evaluations.createSuite(testContext.alice, {
    name: "Deadline",
    cases: [
      { query: "first", expectedMemoryIds },
      { query: "second", expectedMemoryIds },
      { query: "third", expectedMemoryIds },
    ],
  });

  const run = await evaluations.runSuite(testContext.alice, suite.id);

  expect(run).toMatchObject({
    status: "failed",
    error: EVALUATION_RUN_EXPIRED_ERROR,
    metrics: { caseCount: 1 },
  });
  expect(run.results).toHaveLength(1);
});

test("An Evaluation run whose last search passes the deadline ends expired, not completed", async () => {
  const testContext = await createMemoryTestContext();
  let clock = 0;
  const evaluations = createEvaluationModule(testContext.database, {
    // The only search takes 1.1 seconds of a 1-second budget.
    searchProvider: {
      search: async () => {
        clock += 1_100;
        return [];
      },
    },
    now: () => clock,
    runTimeoutSeconds: 1,
  });
  const suite = await evaluations.createSuite(testContext.alice, {
    name: "Late final case",
    cases: [{ query: "only", expectedMemoryIds: ["40000000-0000-4000-8000-000000000005"] }],
  });

  const run = await evaluations.runSuite(testContext.alice, suite.id);

  expect(run).toMatchObject({
    status: "failed",
    error: EVALUATION_RUN_EXPIRED_ERROR,
    metrics: { caseCount: 1 },
  });
  await expect(evaluations.getRun(testContext.alice, run.id)).resolves.toMatchObject({
    status: "failed",
    error: EVALUATION_RUN_EXPIRED_ERROR,
  });
});
