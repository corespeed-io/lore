import retrievalSuite from "../../../evaluation/suites/retrieval-v1.json";
import { createEmbeddingProviderFromEnvironment } from "../../../src/server/providers/embedding/factory";
import { createQueryPlanningProviderFromEnvironment } from "../../../src/server/providers/query-planning/factory";
import { createRerankingProviderFromEnvironment } from "../../../src/server/providers/reranking/factory";
import { strictRetrievalKnobsFromEnvironment } from "../../../src/server/providers/retrieval-knobs";
import type { RetrievalBenchmarkPartition } from "./retrieval";
import { runRetrievalBenchmarkSuite } from "./retrieval-suite";

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
// The deployment's own knob table, strictly: a benchmark refuses an invalid value.
const knobs = strictRetrievalKnobsFromEnvironment(process.env);

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
  knobs,
  queryPlanningProvider,
  rerankingProvider,
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
