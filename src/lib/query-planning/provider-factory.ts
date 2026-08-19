import type { QueryPlanningProvider } from "@corespeed/lore-core";
import {
  createGoogleQueryPlanningProvider,
  createOllamaQueryPlanningProvider,
  createOpenAICompatibleQueryPlanningProvider,
} from "@corespeed/lore-core/providers";

export type QueryPlanningConfigurationWarning = (message: string) => void;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function keepAlive(value: string | undefined): string | number {
  if (value === undefined || value === "") return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

function warnOnPlanningFailure(
  provider: QueryPlanningProvider,
  warn: QueryPlanningConfigurationWarning,
): QueryPlanningProvider {
  return {
    ...provider,
    async plan(input) {
      try {
        return await provider.plan(input);
      } catch (error) {
        warn(
          `Lore ${provider.provider}/${provider.model} query planning failed; using the original query`,
        );
        throw error;
      }
    },
  };
}

export function createQueryPlanningProviderFromEnvironment(
  env: Record<string, string | undefined>,
  warn: QueryPlanningConfigurationWarning = () => undefined,
): QueryPlanningProvider | undefined {
  const provider = env.LORE_QUERY_PLANNER_PROVIDER?.trim().toLowerCase();
  if (!provider) return undefined;
  try {
    if (
      provider !== "google" &&
      provider !== "ollama" &&
      provider !== "openai" &&
      provider !== "vllm"
    ) {
      throw new Error(`unsupported LORE_QUERY_PLANNER_PROVIDER ${JSON.stringify(provider)}`);
    }
    if (provider === "google") {
      return warnOnPlanningFailure(
        createGoogleQueryPlanningProvider({
          model: env.LORE_QUERY_PLANNER_MODEL ?? "",
          apiKey:
            optionalString(env.LORE_QUERY_PLANNER_API_KEY) ??
            optionalString(env.GEMINI_API_KEY) ??
            "",
          baseUrl: optionalString(env.LORE_QUERY_PLANNER_BASE_URL),
          instruction: env.LORE_QUERY_PLANNER_INSTRUCTION,
          timeoutMs: positiveInteger(env.LORE_QUERY_PLANNER_TIMEOUT_MS, 30_000),
        }),
        warn,
      );
    }
    if (provider === "ollama") {
      return warnOnPlanningFailure(
        createOllamaQueryPlanningProvider({
          model: env.LORE_QUERY_PLANNER_MODEL ?? "",
          baseUrl: optionalString(env.LORE_QUERY_PLANNER_BASE_URL) ?? env.OLLAMA_BASE_URL,
          instruction: env.LORE_QUERY_PLANNER_INSTRUCTION,
          keepAlive: keepAlive(env.LORE_QUERY_PLANNER_KEEP_ALIVE ?? env.OLLAMA_KEEP_ALIVE),
          contextWindowTokens: positiveInteger(env.LORE_QUERY_PLANNER_NUM_CTX, 4096),
          timeoutMs: positiveInteger(env.LORE_QUERY_PLANNER_TIMEOUT_MS, 30_000),
        }),
        warn,
      );
    }
    return warnOnPlanningFailure(
      createOpenAICompatibleQueryPlanningProvider({
        provider,
        model: env.LORE_QUERY_PLANNER_MODEL ?? "",
        baseUrl: optionalString(env.LORE_QUERY_PLANNER_BASE_URL),
        apiKey:
          optionalString(env.LORE_QUERY_PLANNER_API_KEY) ?? optionalString(env.OPENAI_API_KEY),
        instruction: env.LORE_QUERY_PLANNER_INSTRUCTION,
        timeoutMs: positiveInteger(env.LORE_QUERY_PLANNER_TIMEOUT_MS, 30_000),
      }),
      warn,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown configuration error";
    warn(`Lore query planning disabled: ${detail}`);
    return undefined;
  }
}
