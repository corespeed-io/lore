import "server-only";
import type { RerankingProvider } from "../reranking";
import { createRerankingProviderFromEnvironment } from "../reranking/provider-factory";

let runtimeRerankingProvider: RerankingProvider | undefined;
let runtimeRerankingProviderInitialized = false;

export function getRuntimeRerankingProvider(
  env: Record<string, string | undefined> = process.env,
): RerankingProvider | undefined {
  if (env !== process.env) {
    return createRerankingProviderFromEnvironment(env, (message) => console.warn(message));
  }
  if (!runtimeRerankingProviderInitialized) {
    runtimeRerankingProvider = createRerankingProviderFromEnvironment(process.env, (message) =>
      console.warn(message),
    );
    runtimeRerankingProviderInitialized = true;
  }
  return runtimeRerankingProvider;
}

export function rerankCandidateLimitFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.LORE_RERANK_CANDIDATE_LIMIT);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
}

export function rerankMinimumScoreFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env.LORE_RERANK_MIN_SCORE;
  if (value === undefined || value.trim() === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn("Lore reranking minimum score must be between 0 and 1; abstention is disabled");
    return 0;
  }
  return parsed;
}

export function rerankDiversityLambdaFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env.LORE_RERANK_DIVERSITY_LAMBDA;
  if (value === undefined || value.trim() === "") return 1;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn("Lore reranking diversity lambda must be between 0 and 1; diversity is disabled");
    return 1;
  }
  return parsed;
}

export function rerankWeightFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env.LORE_RERANK_WEIGHT;
  if (value === undefined || value.trim() === "") return 1;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn("Lore reranking weight must be between 0 and 1; pure reranking is enabled");
    return 1;
  }
  return parsed;
}
