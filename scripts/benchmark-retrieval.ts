import retrievalSuite from "../evaluation/suites/retrieval-v1.json";
import { createEmbeddingProviderFromEnvironment } from "../src/lib/embedding/provider-factory";
import { createQueryPlanningProviderFromEnvironment } from "../src/lib/query-planning/provider-factory";
import { createRerankingProviderFromEnvironment } from "../src/lib/reranking/provider-factory";
import type { RetrievalBenchmarkPartition } from "../src/lib/retrieval-benchmark";
import { runRetrievalBenchmarkSuite } from "./lib/run-retrieval-suite";

const databaseUrl = process.env.BENCHMARK_DATABASE_URL;
if (!databaseUrl) throw new Error("BENCHMARK_DATABASE_URL is required");

const providerWarnings: string[] = [];
const embeddingProvider = createEmbeddingProviderFromEnvironment(process.env, (message) => {
  providerWarnings.push(message);
  console.error(message);
});
if (!embeddingProvider) {
  throw new Error("The retrieval benchmark requires a valid Lore embedding provider");
}
const rerankingProvider = createRerankingProviderFromEnvironment(process.env, (message) => {
  providerWarnings.push(message);
  console.error(message);
});
const queryPlanningProvider = createQueryPlanningProviderFromEnvironment(process.env, (message) => {
  providerWarnings.push(message);
  console.error(message);
});
const configuredQueryPlannerMaxQueries = Number(process.env.LORE_QUERY_PLANNER_MAX_QUERIES ?? 3);
if (
  !Number.isInteger(configuredQueryPlannerMaxQueries) ||
  configuredQueryPlannerMaxQueries < 1 ||
  configuredQueryPlannerMaxQueries > 5
) {
  throw new Error("LORE_QUERY_PLANNER_MAX_QUERIES must be an integer from 1 to 5");
}
const configuredRerankCandidateLimit = Number(process.env.LORE_RERANK_CANDIDATE_LIMIT);
const rerankCandidateLimit =
  Number.isInteger(configuredRerankCandidateLimit) && configuredRerankCandidateLimit > 0
    ? Math.min(configuredRerankCandidateLimit, 200)
    : 50;
const configuredRerankMinimumScore = Number(process.env.LORE_RERANK_MIN_SCORE ?? 0);
if (
  !Number.isFinite(configuredRerankMinimumScore) ||
  configuredRerankMinimumScore < 0 ||
  configuredRerankMinimumScore > 1
) {
  throw new Error("LORE_RERANK_MIN_SCORE must be between 0 and 1");
}
const configuredRerankDiversityLambda = Number(process.env.LORE_RERANK_DIVERSITY_LAMBDA ?? 1);
if (
  !Number.isFinite(configuredRerankDiversityLambda) ||
  configuredRerankDiversityLambda < 0 ||
  configuredRerankDiversityLambda > 1
) {
  throw new Error("LORE_RERANK_DIVERSITY_LAMBDA must be between 0 and 1");
}
const configuredRerankWeight = Number(process.env.LORE_RERANK_WEIGHT ?? 1);
if (
  !Number.isFinite(configuredRerankWeight) ||
  configuredRerankWeight < 0 ||
  configuredRerankWeight > 1
) {
  throw new Error("LORE_RERANK_WEIGHT must be between 0 and 1");
}
const configuredRetrievalRecencyWeight = Number(process.env.LORE_RETRIEVAL_RECENCY_WEIGHT ?? 0);
if (
  !Number.isFinite(configuredRetrievalRecencyWeight) ||
  configuredRetrievalRecencyWeight < 0 ||
  configuredRetrievalRecencyWeight > 1
) {
  throw new Error("LORE_RETRIEVAL_RECENCY_WEIGHT must be between 0 and 1");
}

async function* partitions(): AsyncGenerator<RetrievalBenchmarkPartition> {
  yield {
    key: "retrieval-v1",
    name: "Retrieval Benchmark",
    memories: retrievalSuite.memories.map((memory) => ({
      ...memory,
      owner: memory.owner as "alice" | "bob",
      scope: memory.scope as "shared" | "private",
    })),
    cases: retrievalSuite.cases,
  };
}

const report = await runRetrievalBenchmarkSuite({
  databaseUrl,
  embeddingProvider,
  queryPlanningProvider,
  queryPlannerMaxQueries: configuredQueryPlannerMaxQueries,
  retrievalRecencyWeight: configuredRetrievalRecencyWeight,
  rerankingProvider,
  rerankCandidateLimit,
  rerankDiversityLambda: configuredRerankDiversityLambda,
  rerankMinimumScore: configuredRerankMinimumScore,
  rerankWeight: configuredRerankWeight,
  providerWarnings,
  outputPath: process.env.LORE_BENCHMARK_OUTPUT,
  reuseIndexed: process.env.LORE_BENCHMARK_REUSE_INDEXED === "1",
  suite: {
    name: retrievalSuite.name,
    version: retrievalSuite.version,
    description: retrievalSuite.description,
    thresholds: retrievalSuite.thresholds,
    partitions: partitions(),
  },
});
if (!report.valid) process.exitCode = 1;
