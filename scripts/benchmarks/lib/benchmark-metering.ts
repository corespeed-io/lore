import type {
  EmbeddingProvider,
  EmbeddingTask,
  QueryPlanningProvider,
  RerankingProvider,
} from "@corespeed/lore-core";

interface EmbeddingWorkload {
  calls: number;
  documentCalls: number;
  queryCalls: number;
  inputs: number;
  documentInputs: number;
  queryInputs: number;
  inputCharacters: number;
  documentCharacters: number;
  queryCharacters: number;
}

interface QueryPlanningWorkload {
  calls: number;
  queryCharacters: number;
  generatedQueries: number;
  maximumQueriesRequested: number;
}

interface RerankingWorkload {
  calls: number;
  queryCharacters: number;
  documents: number;
  documentCharacters: number;
  requestedResults: number;
}

export interface BenchmarkWorkload {
  accounting: "request-and-character-counts";
  embedding: EmbeddingWorkload;
  queryPlanning: QueryPlanningWorkload | null;
  reranking: RerankingWorkload | null;
}

export function createBenchmarkMetering(input: {
  embeddingProvider: EmbeddingProvider;
  queryPlanningProvider?: QueryPlanningProvider;
  rerankingProvider?: RerankingProvider;
}): {
  embeddingProvider: EmbeddingProvider;
  queryPlanningProvider?: QueryPlanningProvider;
  rerankingProvider?: RerankingProvider;
  workload: BenchmarkWorkload;
} {
  const embedding: EmbeddingWorkload = {
    calls: 0,
    documentCalls: 0,
    queryCalls: 0,
    inputs: 0,
    documentInputs: 0,
    queryInputs: 0,
    inputCharacters: 0,
    documentCharacters: 0,
    queryCharacters: 0,
  };
  const queryPlanning: QueryPlanningWorkload | null = input.queryPlanningProvider
    ? { calls: 0, queryCharacters: 0, generatedQueries: 0, maximumQueriesRequested: 0 }
    : null;
  const reranking: RerankingWorkload | null = input.rerankingProvider
    ? {
        calls: 0,
        queryCharacters: 0,
        documents: 0,
        documentCharacters: 0,
        requestedResults: 0,
      }
    : null;
  const embeddingProvider: EmbeddingProvider = {
    ...input.embeddingProvider,
    async embed(texts: string[], task: EmbeddingTask): Promise<number[][]> {
      const characters = texts.reduce((total, value) => total + value.length, 0);
      embedding.calls += 1;
      embedding.inputs += texts.length;
      embedding.inputCharacters += characters;
      if (task === "document") {
        embedding.documentCalls += 1;
        embedding.documentInputs += texts.length;
        embedding.documentCharacters += characters;
      } else {
        embedding.queryCalls += 1;
        embedding.queryInputs += texts.length;
        embedding.queryCharacters += characters;
      }
      return input.embeddingProvider.embed(texts, task);
    },
  };
  const queryPlanningProvider =
    input.queryPlanningProvider && queryPlanning
      ? {
          ...input.queryPlanningProvider,
          async plan(planInput: { query: string; maxQueries: number }): Promise<string[]> {
            queryPlanning.calls += 1;
            queryPlanning.queryCharacters += planInput.query.length;
            queryPlanning.maximumQueriesRequested += planInput.maxQueries;
            const queries = await input.queryPlanningProvider?.plan(planInput);
            if (!queries) throw new Error("Query planning provider disappeared");
            queryPlanning.generatedQueries += queries.length;
            return queries;
          },
        }
      : undefined;
  const rerankingProvider =
    input.rerankingProvider && reranking
      ? {
          ...input.rerankingProvider,
          async rerank(rerankInput: Parameters<RerankingProvider["rerank"]>[0]) {
            reranking.calls += 1;
            reranking.queryCharacters += rerankInput.query.length;
            reranking.documents += rerankInput.documents.length;
            reranking.documentCharacters += rerankInput.documents.reduce(
              (total, document) => total + document.text.length,
              0,
            );
            reranking.requestedResults += rerankInput.limit;
            const results = await input.rerankingProvider?.rerank(rerankInput);
            if (!results) throw new Error("Reranking provider disappeared");
            return results;
          },
        }
      : undefined;
  return {
    embeddingProvider,
    queryPlanningProvider,
    rerankingProvider,
    workload: {
      accounting: "request-and-character-counts",
      embedding,
      queryPlanning,
      reranking,
    },
  };
}
