import { resolve } from "node:path";
import { createEmbeddingProviderFromEnvironment } from "../src/lib/embedding/provider-factory";
import { createQueryPlanningProviderFromEnvironment } from "../src/lib/query-planning/provider-factory";
import { createRerankingProviderFromEnvironment } from "../src/lib/reranking/provider-factory";
import { verifyFile } from "./lib/file-integrity";
import {
  type LongMemEvalSplit,
  longMemEvalManifest,
  readLongMemEvalPartitions,
} from "./lib/longmemeval";
import { runRetrievalBenchmarkSuite } from "./lib/run-retrieval-suite";

interface CliOptions {
  split: LongMemEvalSplit;
  datasetPath?: string;
  maxCases?: number;
  casesPerType?: number;
  questionTypes?: Set<string>;
  limit: number;
  outputPath?: string;
  reuseIndexed: boolean;
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { split: "s", limit: 5, reuseIndexed: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--split") {
      if (value !== "oracle" && value !== "s" && value !== "m") {
        throw new Error("--split must be oracle, s, or m");
      }
      options.split = value;
      index += 1;
    } else if (flag === "--dataset") {
      if (!value) throw new Error("--dataset requires a path");
      options.datasetPath = value;
      index += 1;
    } else if (flag === "--max-cases") {
      options.maxCases = positiveInteger(value, flag);
      index += 1;
    } else if (flag === "--cases-per-type") {
      options.casesPerType = positiveInteger(value, flag);
      index += 1;
    } else if (flag === "--question-types") {
      if (!value) throw new Error("--question-types requires a comma-separated value");
      options.questionTypes = new Set(
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      );
      if (options.questionTypes.size === 0) throw new Error("--question-types selected no types");
      index += 1;
    } else if (flag === "--limit") {
      options.limit = positiveInteger(value, flag);
      index += 1;
    } else if (flag === "--output") {
      if (!value) throw new Error("--output requires a path");
      options.outputPath = value;
      index += 1;
    } else if (flag === "--reuse-indexed") {
      options.reuseIndexed = true;
    } else {
      throw new Error(`Unknown LongMemEval option ${flag}`);
    }
  }
  return options;
}

const databaseUrl = process.env.BENCHMARK_DATABASE_URL;
if (!databaseUrl) throw new Error("BENCHMARK_DATABASE_URL is required");
const options = parseArgs(process.argv.slice(2));
const manifestFile = longMemEvalManifest.files[options.split];
const datasetPath = resolve(
  options.datasetPath ??
    process.env.LORE_LONGMEMEVAL_DATASET ??
    `evaluation/datasets/longmemeval/${manifestFile.filename}`,
);
await verifyFile(datasetPath, manifestFile);
if (options.split === "oracle") {
  console.error(
    "LongMemEval oracle contains evidence sessions only; use it for smoke tests, not comparable retrieval scores.",
  );
}

const providerWarnings: string[] = [];
const embeddingProvider = createEmbeddingProviderFromEnvironment(process.env, (message) => {
  providerWarnings.push(message);
  console.error(message);
});
if (!embeddingProvider) {
  throw new Error("The LongMemEval benchmark requires a valid Lore embedding provider");
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
  outputPath: options.outputPath,
  reuseIndexed: options.reuseIndexed,
  suite: {
    name: longMemEvalManifest.name,
    version: longMemEvalManifest.version,
    description: longMemEvalManifest.description,
    thresholds: [0.35, 0.4, 0.45, 0.5],
    provenance: {
      source: longMemEvalManifest.source,
      revision: longMemEvalManifest.revision,
      split: options.split,
      filename: manifestFile.filename,
      sha256: manifestFile.sha256,
      granularity: longMemEvalManifest.granularity,
      duplicateSessionPolicy: "preserve-with-occurrence-suffix",
      blankTurnPolicy: "omit",
      maxCases: options.maxCases ?? null,
      casesPerType: options.casesPerType ?? null,
      questionTypes: options.questionTypes ? [...options.questionTypes].sort() : null,
      retrievalLimit: options.limit,
    },
    partitions: readLongMemEvalPartitions(datasetPath, {
      maxCases: options.maxCases,
      casesPerType: options.casesPerType,
      questionTypes: options.questionTypes,
      limit: options.limit,
    }),
  },
});
if (!report.valid) process.exitCode = 1;
