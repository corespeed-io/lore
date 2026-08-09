import { resolve } from "node:path";
import { createEmbeddingProviderFromEnvironment } from "../src/lib/embedding/provider-factory";
import { createQueryPlanningProviderFromEnvironment } from "../src/lib/query-planning/provider-factory";
import { createRerankingProviderFromEnvironment } from "../src/lib/reranking/provider-factory";
import { verifyFile } from "./lib/file-integrity";
import {
  LOCOMO_CATEGORIES,
  LOCOMO_POSITIVE_CATEGORIES,
  type LocomoCategory,
  locomoManifest,
  readLocomoPartitions,
} from "./lib/locomo";
import { runRetrievalBenchmarkSuite } from "./lib/run-retrieval-suite";

interface CliOptions {
  casesPerCategory?: number;
  categories?: Set<LocomoCategory>;
  datasetPath?: string;
  limit: number;
  maxCases?: number;
  outputPath?: string;
  reuseIndexed: boolean;
  sampleIds?: Set<string>;
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be positive`);
  return parsed;
}

function parseCategory(value: string, flag: string): LocomoCategory {
  const parsed = Number(value);
  if (!LOCOMO_CATEGORIES.includes(parsed as LocomoCategory)) {
    throw new Error(`${flag} values must be LoCoMo categories from 1 to 5`);
  }
  return parsed as LocomoCategory;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    categories: new Set(LOCOMO_POSITIVE_CATEGORIES),
    limit: 10,
    reuseIndexed: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--dataset") {
      if (!value) throw new Error("--dataset requires a path");
      options.datasetPath = value;
      index += 1;
    } else if (flag === "--max-cases") {
      options.maxCases = positiveInteger(value, flag);
      index += 1;
    } else if (flag === "--cases-per-category") {
      options.casesPerCategory = positiveInteger(value, flag);
      index += 1;
    } else if (flag === "--categories") {
      if (!value) throw new Error("--categories requires comma-separated category numbers");
      options.categories = new Set(
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => parseCategory(item, flag)),
      );
      if (!options.categories.size) throw new Error("--categories selected no categories");
      index += 1;
    } else if (flag === "--limit") {
      options.limit = Math.min(100, positiveInteger(value, flag));
      index += 1;
    } else if (flag === "--sample-ids") {
      if (!value) throw new Error("--sample-ids requires comma-separated sample ids");
      options.sampleIds = new Set(
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      );
      if (!options.sampleIds.size) throw new Error("--sample-ids selected no samples");
      index += 1;
    } else if (flag === "--output") {
      if (!value) throw new Error("--output requires a path");
      options.outputPath = value;
      index += 1;
    } else if (flag === "--reuse-indexed") {
      options.reuseIndexed = true;
    } else {
      throw new Error(`Unknown LoCoMo retrieval option ${flag}`);
    }
  }
  if (options.categories?.has(5)) {
    throw new Error(
      "LoCoMo category 5 is excluded from the retrieval diagnostic because its released QA metric is single-label and non-comparable",
    );
  }
  return options;
}

const databaseUrl = process.env.BENCHMARK_DATABASE_URL;
if (!databaseUrl) throw new Error("BENCHMARK_DATABASE_URL is required");
const options = parseArgs(process.argv.slice(2));
const manifestFile = locomoManifest.files.dataset;
const datasetPath = resolve(
  options.datasetPath ??
    process.env.LORE_LOCOMO_DATASET ??
    `evaluation/datasets/locomo/${manifestFile.filename}`,
);
await verifyFile(datasetPath, manifestFile);

const providerWarnings: string[] = [];
const embeddingProvider = createEmbeddingProviderFromEnvironment(process.env, (message) => {
  providerWarnings.push(message);
  console.error(message);
});
if (!embeddingProvider) throw new Error("The LoCoMo benchmark requires an embedding provider");
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
const contextGroupMetadataKey = process.env.LORE_BENCHMARK_CONTEXT_GROUP_KEY?.trim() || undefined;
const contextGroupOrdinalMetadataKey =
  process.env.LORE_BENCHMARK_CONTEXT_GROUP_ORDINAL_KEY?.trim() || undefined;
const contextGroupBaseCandidateLimit = Number(
  process.env.LORE_BENCHMARK_CONTEXT_GROUP_BASE_LIMIT ?? 20,
);
if (
  !Number.isInteger(contextGroupBaseCandidateLimit) ||
  contextGroupBaseCandidateLimit < 1 ||
  contextGroupBaseCandidateLimit > 200
) {
  throw new Error("LORE_BENCHMARK_CONTEXT_GROUP_BASE_LIMIT must be an integer from 1 to 200");
}
const contextGroupMaximumGroups = Number(process.env.LORE_BENCHMARK_CONTEXT_GROUP_MAX_GROUPS ?? 3);
if (
  !Number.isInteger(contextGroupMaximumGroups) ||
  contextGroupMaximumGroups < 1 ||
  contextGroupMaximumGroups > 20
) {
  throw new Error("LORE_BENCHMARK_CONTEXT_GROUP_MAX_GROUPS must be an integer from 1 to 20");
}

const report = await runRetrievalBenchmarkSuite({
  contextGroupExpansion: contextGroupMetadataKey
    ? {
        groupMetadataKey: contextGroupMetadataKey,
        ...(contextGroupOrdinalMetadataKey
          ? { ordinalMetadataKey: contextGroupOrdinalMetadataKey }
          : {}),
        baseCandidateLimit: contextGroupBaseCandidateLimit,
        maximumGroups: contextGroupMaximumGroups,
      }
    : undefined,
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
    name: `${locomoManifest.name} annotated-dialog retrieval`,
    version: locomoManifest.version,
    description:
      "Lore retrieval over the official LoCoMo dialog-turn corpus. This is a retrieval diagnostic, not the complete LoCoMo score.",
    thresholds: [0.35, 0.4, 0.45, 0.5],
    provenance: {
      source: locomoManifest.source,
      paper: locomoManifest.paper,
      revision: locomoManifest.revision,
      filename: manifestFile.filename,
      sha256: manifestFile.sha256,
      license: locomoManifest.license,
      granularity: locomoManifest.granularity,
      protocol: "locomo-annotated-dialog-retrieval-v1",
      evidenceMetric: "question-level annotated-dialog Recall@K/MRR/nDCG",
      evidenceNormalization:
        "extract-dialog-ids-repair-D-session-turn-and-leading-zero-v1; unresolved annotations excluded",
      excludesQuestionsWithoutAnnotatedEvidence: true,
      maxCases: options.maxCases ?? null,
      casesPerCategory: options.casesPerCategory ?? null,
      categories: options.categories ? [...options.categories].sort() : LOCOMO_POSITIVE_CATEGORIES,
      sampleIds: options.sampleIds ? [...options.sampleIds].sort() : null,
      retrievalLimit: options.limit,
    },
    partitions: readLocomoPartitions(datasetPath, {
      maxCases: options.maxCases,
      casesPerCategory: options.casesPerCategory,
      categories: options.categories,
      limit: options.limit,
      sampleIds: options.sampleIds,
    }),
  },
});
if (!report.valid) process.exitCode = 1;
