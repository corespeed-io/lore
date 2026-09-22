import type { ConfiguredRerankingProvider } from "../metadata";
import { createHostedRerankingProvider } from "./hosted";
import { createOllamaListwiseRerankingProvider } from "./ollama-listwise";
import {
  createLlamaCppRerankingProvider,
  createVllmRerankingProvider,
  createVllmScoreRerankingProvider,
} from "./vllm";

export type RerankingConfigurationWarning = (message: string) => void;

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

function warnOnRerankingFailure(
  provider: ConfiguredRerankingProvider,
  warn: RerankingConfigurationWarning,
): ConfiguredRerankingProvider {
  return {
    ...provider,
    async rerank(input) {
      try {
        return await provider.rerank(input);
      } catch (error) {
        warn(
          `Lore ${provider.provider}/${provider.model} reranking failed; using deterministic retrieval order`,
        );
        throw error;
      }
    },
  };
}

export function createRerankingProviderFromEnvironment(
  env: Record<string, string | undefined>,
  warn: RerankingConfigurationWarning = () => undefined,
): ConfiguredRerankingProvider | undefined {
  const provider = env.LORE_RERANK_PROVIDER?.trim().toLowerCase();
  if (!provider) return undefined;
  try {
    if (
      provider !== "vllm" &&
      provider !== "vllm-score" &&
      provider !== "llamacpp" &&
      provider !== "ollama-listwise" &&
      provider !== "cohere" &&
      provider !== "memos" &&
      provider !== "vercel" &&
      provider !== "voyage"
    ) {
      throw new Error(`unsupported LORE_RERANK_PROVIDER ${JSON.stringify(provider)}`);
    }
    const configured =
      provider === "ollama-listwise"
        ? createOllamaListwiseRerankingProvider({
            model: env.LORE_RERANK_MODEL ?? "",
            baseUrl: optionalString(env.LORE_RERANK_BASE_URL),
            contextWindowTokens: positiveInteger(env.LORE_RERANK_NUM_CTX, 8_192),
            maximumOutputTokens: positiveInteger(env.LORE_RERANK_MAX_OUTPUT_TOKENS, 2_048),
            maximumDocumentCharacters: positiveInteger(env.LORE_RERANK_MAX_DOCUMENT_CHARS, 600),
            keepAlive: keepAlive(env.LORE_RERANK_KEEP_ALIVE),
          })
        : provider === "vllm" || provider === "vllm-score" || provider === "llamacpp"
          ? (provider === "vllm"
              ? createVllmRerankingProvider
              : provider === "vllm-score"
                ? createVllmScoreRerankingProvider
                : createLlamaCppRerankingProvider)({
              model: env.LORE_RERANK_MODEL ?? "",
              baseUrl: optionalString(env.LORE_RERANK_BASE_URL),
              apiKey: optionalString(env.LORE_RERANK_API_KEY),
              ...(provider === "vllm" || provider === "vllm-score"
                ? { instruction: env.LORE_RERANK_INSTRUCTION }
                : {}),
              timeoutMs: positiveInteger(env.LORE_RERANK_TIMEOUT_MS, 30_000),
            })
          : createHostedRerankingProvider({
              provider,
              model: env.LORE_RERANK_MODEL ?? "",
              baseUrl: optionalString(env.LORE_RERANK_BASE_URL),
              apiKey:
                optionalString(env.LORE_RERANK_API_KEY) ??
                (provider === "cohere"
                  ? optionalString(env.COHERE_API_KEY)
                  : provider === "memos"
                    ? optionalString(env.MEMOS_API_KEY)
                    : provider === "vercel"
                      ? optionalString(env.AI_GATEWAY_API_KEY)
                      : optionalString(env.VOYAGE_API_KEY)) ??
                "",
              instruction: env.LORE_RERANK_INSTRUCTION,
              timeoutMs: positiveInteger(env.LORE_RERANK_TIMEOUT_MS, 30_000),
            });
    if (provider === "llamacpp" && optionalString(env.LORE_RERANK_INSTRUCTION)) {
      warn(
        "Lore llamacpp reranking ignores LORE_RERANK_INSTRUCTION; the GGUF model owns its template",
      );
    }
    if (provider === "vercel" && optionalString(env.LORE_RERANK_INSTRUCTION)) {
      warn(
        "Lore Vercel AI Gateway reranking ignores LORE_RERANK_INSTRUCTION; the Cohere Rerank contract has no instruction field",
      );
    }
    return warnOnRerankingFailure(configured, warn);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown configuration error";
    warn(`Lore reranking disabled: ${detail}`);
    return undefined;
  }
}
