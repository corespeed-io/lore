import "server-only";
import type {
  EmbeddingProvider,
  MemoryMaintenanceNotifier,
  MemoryModuleOptions,
} from "@corespeed/lore-core";
import { createEmbeddingProviderFromEnvironment } from "../embedding/provider-factory";
import {
  getRuntimeQueryPlanningProvider,
  queryPlannerMaxQueriesFromEnvironment,
} from "./query-planning";
import {
  getRuntimeRerankingProvider,
  rerankCandidateLimitFromEnvironment,
  rerankDiversityLambdaFromEnvironment,
  rerankMinimumScoreFromEnvironment,
  rerankWeightFromEnvironment,
} from "./reranking";

let runtimeEmbeddingProvider: EmbeddingProvider | undefined;
let runtimeEmbeddingProviderInitialized = false;

export function getRuntimeEmbeddingProvider(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProvider | undefined {
  if (env !== process.env) {
    return createEmbeddingProviderFromEnvironment(env, (message) => console.warn(message));
  }
  if (!runtimeEmbeddingProviderInitialized) {
    runtimeEmbeddingProvider = createEmbeddingProviderFromEnvironment(process.env, (message) =>
      console.warn(message),
    );
    runtimeEmbeddingProviderInitialized = true;
  }
  return runtimeEmbeddingProvider;
}

export function semanticDistanceThresholdFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env.LORE_SEMANTIC_DISTANCE_THRESHOLD;
  if (value === undefined || value.trim() === "") return 0.5;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    console.warn("Lore semantic distance threshold must be between 0 and 2; using the 0.5 default");
    return 0.5;
  }
  return parsed;
}

export function evidenceNeighborChunksFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.LORE_EVIDENCE_NEIGHBOR_CHUNKS ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2) {
    console.warn("Lore evidence neighbor chunks must be an integer from 0 to 2; using 0");
    return 0;
  }
  return parsed;
}

export function evidenceTopChunksFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.LORE_EVIDENCE_TOP_CHUNKS ?? 1);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    console.warn("Lore evidence top chunks must be an integer from 1 to 5; using 1");
    return 1;
  }
  return parsed;
}

export function retrievalFeedbackQueriesFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.LORE_RETRIEVAL_FEEDBACK_QUERIES ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3) {
    console.warn("Lore retrieval feedback queries must be an integer from 0 to 3; using 0");
    return 0;
  }
  return parsed;
}

export function retrievalRecencyWeightFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env.LORE_RETRIEVAL_RECENCY_WEIGHT;
  if (value === undefined || value.trim() === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn("Lore retrieval recency weight must be between 0 and 1; recency is disabled");
    return 0;
  }
  return parsed;
}

export function entityAliasRecallFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.LORE_ENTITY_ALIAS_RECALL?.trim().toLowerCase();
  if (!value) return false;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  console.warn("LORE_ENTITY_ALIAS_RECALL must be 0, 1, false, or true; entity recall is disabled");
  return false;
}

async function getCloudflareMaintenanceNotifier(): Promise<MemoryMaintenanceNotifier | undefined> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const context = await getCloudflareContext({ async: true });
    const queue = context.env.MEMORY_MAINTENANCE_QUEUE;
    if (!queue) return undefined;
    return {
      notify(message) {
        context.ctx.waitUntil(
          queue
            .send(message)
            .catch(() =>
              console.warn("Lore maintenance queue notification failed; sweep will retry"),
            ),
        );
      },
    };
  } catch {
    // The Node/Docker worker polls the durable job table directly.
    return undefined;
  }
}

export async function getRuntimeMemoryModuleOptions(
  options: { maintenanceNotifications?: boolean } = {},
): Promise<MemoryModuleOptions> {
  return {
    embeddingProvider: getRuntimeEmbeddingProvider(),
    entityAliasRecall: entityAliasRecallFromEnvironment(),
    evidenceNeighborChunks: evidenceNeighborChunksFromEnvironment(),
    evidenceTopChunks: evidenceTopChunksFromEnvironment(),
    maintenanceNotifier: options.maintenanceNotifications
      ? await getCloudflareMaintenanceNotifier()
      : undefined,
    queryPlanningProvider: getRuntimeQueryPlanningProvider(),
    queryPlannerMaxQueries: queryPlannerMaxQueriesFromEnvironment(),
    retrievalFeedbackQueries: retrievalFeedbackQueriesFromEnvironment(),
    retrievalRecencyWeight: retrievalRecencyWeightFromEnvironment(),
    rerankingProvider: getRuntimeRerankingProvider(),
    rerankCandidateLimit: rerankCandidateLimitFromEnvironment(),
    rerankDiversityLambda: rerankDiversityLambdaFromEnvironment(),
    rerankMinimumScore: rerankMinimumScoreFromEnvironment(),
    rerankWeight: rerankWeightFromEnvironment(),
    semanticDistanceThreshold: semanticDistanceThresholdFromEnvironment(),
  };
}
