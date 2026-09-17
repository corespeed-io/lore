import type { MemoryMaintenanceNotifier, MemoryModuleOptions } from "@corespeed/lore-core";
import { EMBEDDING_DIMENSIONS } from "./embedding/config";
import { createEmbeddingProviderFromEnvironment } from "./embedding/factory";
import { createQueryPlanningProviderFromEnvironment } from "./query-planning/factory";
import { createRerankingProviderFromEnvironment } from "./reranking/factory";

let runtimeProviders:
  | Pick<MemoryModuleOptions, "embeddingProvider" | "queryPlanningProvider" | "rerankingProvider">
  | undefined;

const warn = (message: string) => console.warn(message);

function numberFromEnvironment(
  name: string,
  fallback: number,
  [minimum, maximum]: [number, number],
  options: { integer?: boolean; emptyIsZero?: boolean } = {},
): number {
  const raw = process.env[name];
  const value = raw === undefined || (!options.emptyIsZero && !raw.trim()) ? fallback : Number(raw);
  if (
    (options.integer ? Number.isInteger(value) : Number.isFinite(value)) &&
    value >= minimum &&
    value <= maximum
  )
    return value;
  warn(
    `${name} must be ${options.integer ? "an integer " : ""}between ${minimum} and ${maximum}; using ${fallback}`,
  );
  return fallback;
}

function entityAliasRecallFromEnvironment(): boolean {
  const value = process.env.LORE_ENTITY_ALIAS_RECALL?.trim().toLowerCase();
  if (!value) return false;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  console.warn("LORE_ENTITY_ALIAS_RECALL must be 0, 1, false, or true; entity recall is disabled");
  return false;
}

function rerankCandidateLimitFromEnvironment(): number {
  const parsed = Number(process.env.LORE_RERANK_CANDIDATE_LIMIT);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
}

export function getRuntimeMemoryModuleOptions(
  options: { maintenanceNotifier?: MemoryMaintenanceNotifier } = {},
): MemoryModuleOptions {
  runtimeProviders ??= {
    embeddingProvider: createEmbeddingProviderFromEnvironment(process.env, warn),
    queryPlanningProvider: createQueryPlanningProviderFromEnvironment(process.env, warn),
    rerankingProvider: createRerankingProviderFromEnvironment(process.env, warn),
  };
  return {
    ...runtimeProviders,
    // Lore v1 protocol invariant: the baseline schema is built for 1024.
    embeddingDimensions: EMBEDDING_DIMENSIONS,
    entityAliasRecall: entityAliasRecallFromEnvironment(),
    evidenceNeighborChunks: numberFromEnvironment("LORE_EVIDENCE_NEIGHBOR_CHUNKS", 0, [0, 2], {
      integer: true,
      emptyIsZero: true,
    }),
    evidenceTopChunks: numberFromEnvironment("LORE_EVIDENCE_TOP_CHUNKS", 1, [1, 5], {
      integer: true,
      emptyIsZero: true,
    }),
    maintenanceNotifier: options.maintenanceNotifier,
    queryPlannerMaxQueries: numberFromEnvironment("LORE_QUERY_PLANNER_MAX_QUERIES", 3, [1, 5], {
      integer: true,
    }),
    retrievalFeedbackQueries: numberFromEnvironment("LORE_RETRIEVAL_FEEDBACK_QUERIES", 0, [0, 3], {
      integer: true,
      emptyIsZero: true,
    }),
    retrievalRecencyWeight: numberFromEnvironment("LORE_RETRIEVAL_RECENCY_WEIGHT", 0, [0, 1]),
    rerankCandidateLimit: rerankCandidateLimitFromEnvironment(),
    rerankDiversityLambda: numberFromEnvironment("LORE_RERANK_DIVERSITY_LAMBDA", 1, [0, 1]),
    rerankMinimumScore: numberFromEnvironment("LORE_RERANK_MIN_SCORE", 0, [0, 1]),
    rerankWeight: numberFromEnvironment("LORE_RERANK_WEIGHT", 1, [0, 1]),
    semanticDistanceThreshold: numberFromEnvironment(
      "LORE_SEMANTIC_DISTANCE_THRESHOLD",
      0.5,
      [0, 2],
    ),
  };
}
