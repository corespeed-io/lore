import type { RerankDocument, RerankingProvider, RerankResult } from "../reranking";

const DEFAULT_VLLM_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_LLAMACPP_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_INSTRUCTION =
  "Given a memory recall query, retrieve relevant memory passages that answer the query";
const QWEN3_LLAMACPP_INSTRUCTION =
  "Given a web search query, retrieve relevant passages that answer the query";
const MODEL_EMBEDDED_LLAMACPP_INSTRUCTION =
  "Model-embedded llama.cpp rerank template; Lore sends no instruction override";

type LocalRerankingProvider = "vllm" | "llamacpp";

export interface VllmRerankingOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  instruction?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export type LlamaCppRerankingOptions = Omit<VllmRerankingOptions, "instruction">;

export type VllmScoreRerankingOptions = VllmRerankingOptions;

interface VllmRerankResponse {
  results?: unknown;
}

interface VllmScoreResponse {
  data?: unknown;
}

function endpoint(baseUrl: string, provider: LocalRerankingProvider): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${provider} reranking base URL must use http or https`);
  }
  const base = `${url.toString().replace(/\/$/, "")}/`;
  return new URL("v1/rerank", base).toString();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function parseResults(
  payload: VllmRerankResponse,
  documents: RerankDocument[],
  expectedCount: number,
  provider: LocalRerankingProvider,
): RerankResult[] {
  if (!Array.isArray(payload.results) || payload.results.length !== expectedCount) {
    throw new Error(`${provider} returned the wrong number of reranking results`);
  }
  const seen = new Set<number>();
  return payload.results.map((item) => {
    const index =
      typeof item === "object" && item !== null && "index" in item
        ? (item as { index?: unknown }).index
        : undefined;
    const score =
      typeof item === "object" && item !== null && "relevance_score" in item
        ? (item as { relevance_score?: unknown }).relevance_score
        : undefined;
    if (
      !Number.isInteger(index) ||
      (index as number) < 0 ||
      (index as number) >= documents.length ||
      seen.has(index as number) ||
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    ) {
      throw new Error(`${provider} returned an invalid reranking result`);
    }
    seen.add(index as number);
    return {
      documentId: documents[index as number].id,
      score,
    };
  });
}

function parseScoreResults(
  payload: VllmScoreResponse,
  documents: RerankDocument[],
): RerankResult[] {
  if (!Array.isArray(payload.data) || payload.data.length !== documents.length) {
    throw new Error("vllm-score returned the wrong number of reranking results");
  }
  const seen = new Set<number>();
  return payload.data.map((item) => {
    const index =
      typeof item === "object" && item !== null && "index" in item
        ? (item as { index?: unknown }).index
        : undefined;
    const score =
      typeof item === "object" && item !== null && "score" in item
        ? (item as { score?: unknown }).score
        : undefined;
    if (
      !Number.isInteger(index) ||
      (index as number) < 0 ||
      (index as number) >= documents.length ||
      seen.has(index as number) ||
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    ) {
      throw new Error("vllm-score returned an invalid reranking result");
    }
    seen.add(index as number);
    return { documentId: documents[index as number].id, score };
  });
}

function createLocalRerankingProvider(
  provider: LocalRerankingProvider,
  options: VllmRerankingOptions,
): RerankingProvider {
  const model = options.model.trim();
  if (!model)
    throw new Error(`LORE_RERANK_MODEL is required for the ${provider} reranking provider`);
  const instruction =
    provider === "vllm"
      ? options.instruction?.trim() || DEFAULT_INSTRUCTION
      : model.toLowerCase().includes("qwen3-reranker")
        ? QWEN3_LLAMACPP_INSTRUCTION
        : MODEL_EMBEDDED_LLAMACPP_INSTRUCTION;
  const timeoutMs = positiveInteger(options.timeoutMs, 30_000);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const url = endpoint(
    options.baseUrl ?? (provider === "vllm" ? DEFAULT_VLLM_BASE_URL : DEFAULT_LLAMACPP_BASE_URL),
    provider,
  );
  const apiKey = options.apiKey?.trim();

  return {
    provider,
    model,
    revision: provider === "vllm" ? "lore-reranking-v1" : "lore-llamacpp-reranking-v1",
    instruction,
    async rerank({ query, documents, limit }): Promise<RerankResult[]> {
      if (!documents.length || limit < 1) return [];
      const topN = Math.min(limit, documents.length);
      const response = await fetchImplementation(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          query,
          documents: documents.map((document) => document.text),
          top_n: topN,
          ...(provider === "vllm" ? { chat_template_kwargs: { instruction } } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`${provider} reranking request failed with HTTP ${response.status}`);
      }
      return parseResults((await response.json()) as VllmRerankResponse, documents, topN, provider);
    },
  };
}

export function createVllmRerankingProvider(options: VllmRerankingOptions): RerankingProvider {
  return createLocalRerankingProvider("vllm", options);
}

export function createLlamaCppRerankingProvider(
  options: LlamaCppRerankingOptions,
): RerankingProvider {
  return createLocalRerankingProvider("llamacpp", options);
}

export function createVllmScoreRerankingProvider(
  options: VllmScoreRerankingOptions,
): RerankingProvider {
  const model = options.model.trim();
  if (!model)
    throw new Error("LORE_RERANK_MODEL is required for the vllm-score reranking provider");
  const instruction = options.instruction?.trim() || DEFAULT_INSTRUCTION;
  const timeoutMs = positiveInteger(options.timeoutMs, 30_000);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const url = new URL("score", `${(options.baseUrl ?? DEFAULT_VLLM_BASE_URL).replace(/\/$/, "")}/`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("vllm-score reranking base URL must use http or https");
  }
  const apiKey = options.apiKey?.trim();

  return {
    provider: "vllm-score",
    model,
    revision: "lore-vllm-score-reranking-v1",
    instruction,
    async rerank({ query, documents, limit }): Promise<RerankResult[]> {
      if (!documents.length || limit < 1) return [];
      const response = await fetchImplementation(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          text_1: documents.map(() => query),
          text_2: documents.map((document) => document.text),
          instruction,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`vllm-score reranking request failed with HTTP ${response.status}`);
      }
      const originalIndexById = new Map(
        documents.map((document, index) => [document.id, index] as const),
      );
      return parseScoreResults((await response.json()) as VllmScoreResponse, documents)
        .sort(
          (left, right) =>
            right.score - left.score ||
            (originalIndexById.get(left.documentId) ?? 0) -
              (originalIndexById.get(right.documentId) ?? 0),
        )
        .slice(0, Math.min(limit, documents.length));
    },
  };
}
