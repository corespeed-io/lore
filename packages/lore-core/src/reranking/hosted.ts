import { providerHttpError, readBoundedResponseJson } from "../provider-response";
import type { RerankDocument, RerankingProvider, RerankResult } from "../reranking";

type HostedRerankingProvider = "cohere" | "memos" | "voyage";

export interface HostedRerankingOptions {
  provider: HostedRerankingProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  instruction?: string;
  batchMaxCharacters?: number;
  fetch?: typeof globalThis.fetch;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function endpoint(provider: HostedRerankingProvider, baseUrl?: string): string {
  const defaultBaseUrl =
    provider === "cohere"
      ? "https://api.cohere.com"
      : provider === "memos"
        ? "https://memos.memtensor.cn/api/openmem/v1"
        : "https://api.voyageai.com";
  const url = new URL(baseUrl ?? defaultBaseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${provider} reranking base URL must use http or https`);
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`${provider} reranking base URL must use https outside localhost`);
  }
  const path = provider === "cohere" ? "v2/rerank" : provider === "memos" ? "rerank" : "v1/rerank";
  return new URL(path, `${url.toString().replace(/\/$/, "")}/`).toString();
}

function documentBatches(
  documents: RerankDocument[],
  maximumCharacters: number,
): RerankDocument[][] {
  const batches: RerankDocument[][] = [];
  let batch: RerankDocument[] = [];
  let characters = 0;
  for (const document of documents) {
    const nextCharacters = [...document.text].length;
    if (batch.length > 0 && characters + nextCharacters > maximumCharacters) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(document);
    characters += nextCharacters;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function rerankMemosBatches(
  batches: RerankDocument[][],
  rerank: (batch: RerankDocument[]) => Promise<RerankResult[]>,
): Promise<RerankResult[]> {
  const output: RerankResult[][] = new Array(batches.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, batches.length) }, async () => {
      while (nextIndex < batches.length) {
        const index = nextIndex;
        nextIndex += 1;
        const batch = batches[index];
        if (!batch) continue;
        output[index] = await rerank(batch);
      }
    }),
  );
  return output.flat();
}

function parseResults(
  payload: { data?: unknown; results?: unknown },
  documents: RerankDocument[],
  expectedCount: number,
  provider: HostedRerankingProvider,
): RerankResult[] {
  const results = provider === "voyage" ? payload.data : payload.results;
  if (!Array.isArray(results) || results.length !== expectedCount) {
    throw new Error(`${provider} returned the wrong number of reranking results`);
  }
  const seen = new Set<number>();
  return results.map((item) => {
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
    const document = documents[index as number];
    if (!document) throw new Error(`${provider} returned an invalid reranking result`);
    return { documentId: document.id, score };
  });
}

export function createHostedRerankingProvider(options: HostedRerankingOptions): RerankingProvider {
  const model = options.model.trim();
  if (!model) throw new Error(`LORE_RERANK_MODEL is required for ${options.provider}`);
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error(`LORE_RERANK_API_KEY is required for ${options.provider}`);
  const timeoutMs = positiveInteger(options.timeoutMs, 30_000);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const url = endpoint(options.provider, options.baseUrl);
  const instruction = options.provider === "voyage" ? options.instruction?.trim() : undefined;
  const batchMaxCharacters = positiveInteger(options.batchMaxCharacters, 6_000);
  const fetchRerank = async (
    query: string,
    documents: RerankDocument[],
    top: number,
  ): Promise<RerankResult[]> => {
    const effectiveQuery =
      options.provider === "voyage" && instruction ? `${instruction}\n\n${query}` : query;
    const response = await fetchImplementation(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `${options.provider === "memos" ? "Token" : "Bearer"} ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        query: effectiveQuery,
        documents: documents.map((document) => document.text),
        ...(options.provider === "cohere" || options.provider === "memos"
          ? { top_n: top }
          : { top_k: top, return_documents: false, truncation: true }),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw await providerHttpError(
        response,
        `${options.provider} reranking request failed with HTTP ${response.status}`,
      );
    }
    return parseResults(
      await readBoundedResponseJson<{ data?: unknown; results?: unknown }>(response),
      documents,
      top,
      options.provider,
    );
  };
  return {
    provider: options.provider,
    model,
    revision: `lore-${options.provider}-reranking-v1`,
    ...(instruction !== undefined ? { instruction } : {}),
    async rerank({ query, documents, limit }): Promise<RerankResult[]> {
      if (!documents.length || limit < 1) return [];
      const top = Math.min(limit, documents.length);
      if (options.provider !== "memos") {
        return fetchRerank(query, documents, top);
      }
      const originalIndexById = new Map(
        documents.map((document, index) => [document.id, index] as const),
      );
      const results = await rerankMemosBatches(
        documentBatches(documents, batchMaxCharacters),
        (batch) => fetchRerank(query, batch, batch.length),
      );
      return results
        .sort(
          (left, right) =>
            right.score - left.score ||
            (originalIndexById.get(left.documentId) ?? 0) -
              (originalIndexById.get(right.documentId) ?? 0),
        )
        .slice(0, top);
    },
  };
}
