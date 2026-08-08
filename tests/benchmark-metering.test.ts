import { expect, test } from "vitest";
import { createBenchmarkMetering } from "../scripts/lib/benchmark-metering";

test("benchmark metering records actual provider workload", async () => {
  const metering = createBenchmarkMetering({
    embeddingProvider: {
      provider: "test",
      model: "embed",
      dimensions: 1024,
      revision: "v1",
      embed: async (texts) => texts.map(() => Array.from({ length: 1024 }, () => 0)),
    },
    queryPlanningProvider: {
      provider: "test",
      model: "planner",
      plan: async () => ["rewrite"],
    },
    rerankingProvider: {
      provider: "test",
      model: "reranker",
      rerank: async ({ documents }) =>
        documents.map((document, index) => ({ documentId: document.id, score: 1 - index / 10 })),
    },
  });

  await metering.embeddingProvider.embed(["abc", "de"], "document");
  await metering.embeddingProvider.embed(["query"], "query");
  await metering.queryPlanningProvider?.plan({ query: "when", maxQueries: 2 });
  await metering.rerankingProvider?.rerank({
    query: "where",
    documents: [
      { id: "one", text: "alpha" },
      { id: "two", text: "beta" },
    ],
    limit: 1,
  });

  expect(metering.workload).toEqual({
    accounting: "request-and-character-counts",
    embedding: {
      calls: 2,
      documentCalls: 1,
      queryCalls: 1,
      inputs: 3,
      documentInputs: 2,
      queryInputs: 1,
      inputCharacters: 10,
      documentCharacters: 5,
      queryCharacters: 5,
    },
    queryPlanning: {
      calls: 1,
      queryCharacters: 4,
      generatedQueries: 1,
      maximumQueriesRequested: 2,
    },
    reranking: {
      calls: 1,
      queryCharacters: 5,
      documents: 2,
      documentCharacters: 9,
      requestedResults: 1,
    },
  });
});
