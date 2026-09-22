import type { RerankDocument, RerankResult } from "@corespeed/lore-core";
import { CohereClientV2 } from "cohere-ai";
import { VoyageAIClient } from "voyageai";
import {
  assertVercelAIGatewayModel,
  VERCEL_AI_GATEWAY_HOST,
} from "@/server/providers/vercel-ai-gateway";
import type { ConfiguredRerankingProvider } from "../metadata";
import { requestProviderJson } from "../request";

type HostedRerankingProvider = "cohere" | "memos" | "vercel" | "voyage";

/**
 * Vercel AI Gateway serves reranking as the Cohere Rerank contract
 * (`POST /v2/rerank`) rather than on its OpenAI-compatible surface, so the same
 * Cohere client reaches it with only a host and credential change. The dialect
 * carries no instruction field.
 */

export interface HostedRerankingOptions {
  provider: HostedRerankingProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  instruction?: string;
  batchMaxCharacters?: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function providerBaseUrl(provider: HostedRerankingProvider, baseUrl?: string): string {
  const defaultBaseUrl =
    provider === "cohere"
      ? "https://api.cohere.com"
      : provider === "memos"
        ? "https://memos.memtensor.cn/api/openmem/v1"
        : provider === "vercel"
          ? VERCEL_AI_GATEWAY_HOST
          : "https://api.voyageai.com";
  const url = new URL(baseUrl ?? defaultBaseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${provider} reranking base URL must use http or https`);
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`${provider} reranking base URL must use https outside localhost`);
  }
  return url.toString().replace(/\/$/, "");
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
  results: unknown,
  documents: RerankDocument[],
  expectedCount: number,
  provider: HostedRerankingProvider,
): RerankResult[] {
  if (!Array.isArray(results) || results.length !== expectedCount) {
    throw new Error(`${provider} returned the wrong number of reranking results`);
  }
  const seen = new Set<number>();
  return results.map((item) => {
    const index =
      typeof item === "object" && item !== null && "index" in item
        ? (item as { index?: unknown }).index
        : undefined;
    const scoreKey = provider === "memos" ? "relevance_score" : "relevanceScore";
    const score =
      typeof item === "object" && item !== null && scoreKey in item
        ? (item as Record<string, unknown>)[scoreKey]
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

export function createHostedRerankingProvider(
  options: HostedRerankingOptions,
): ConfiguredRerankingProvider {
  const model = options.model.trim();
  if (!model) throw new Error(`LORE_RERANK_MODEL is required for ${options.provider}`);
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error(`LORE_RERANK_API_KEY is required for ${options.provider}`);
  if (options.provider === "vercel") assertVercelAIGatewayModel(model, "cohere/rerank-v3.5");
  const timeoutMs = positiveInteger(options.timeoutMs, 30_000);
  const baseUrl = providerBaseUrl(options.provider, options.baseUrl);
  const sdkOptions = {
    timeoutInSeconds: timeoutMs / 1_000,
    maxRetries: 0,
  };
  const cohere =
    options.provider === "cohere" || options.provider === "vercel"
      ? new CohereClientV2({ ...sdkOptions, token: apiKey, baseUrl })
      : undefined;
  const voyage =
    options.provider === "voyage"
      ? new VoyageAIClient({
          apiKey,
          environment: new URL("v1", `${baseUrl}/`).toString(),
        })
      : undefined;
  const instruction = options.provider === "voyage" ? options.instruction?.trim() : undefined;
  const batchMaxCharacters = positiveInteger(options.batchMaxCharacters, 6_000);
  const fetchRerank = async (
    query: string,
    documents: RerankDocument[],
    top: number,
  ): Promise<RerankResult[]> => {
    const effectiveQuery =
      options.provider === "voyage" && instruction ? `${instruction}\n\n${query}` : query;
    if (cohere || voyage) {
      let results: unknown;
      try {
        if (cohere) {
          results = (
            await cohere.rerank({
              model,
              query: effectiveQuery,
              documents: documents.map((document) => document.text),
              topN: top,
            })
          ).results;
        } else if (voyage) {
          results = (
            await voyage.rerank(
              {
                model,
                query: effectiveQuery,
                documents: documents.map((document) => document.text),
                topK: top,
                returnDocuments: false,
                truncation: true,
              },
              sdkOptions,
            )
          ).data;
        }
      } catch (error) {
        const status =
          typeof error === "object" && error !== null && "statusCode" in error
            ? error.statusCode
            : undefined;
        throw new Error(
          `${options.provider} reranking request failed${typeof status === "number" ? ` with HTTP ${status}` : ""}`,
        );
      }
      return parseResults(results, documents, top, options.provider);
    }
    // MemOS has no supported TypeScript SDK for its Token-authenticated rerank API.
    const payload = await requestProviderJson<{ results?: unknown }>(
      new URL("rerank", `${baseUrl}/`).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Token ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          query: effectiveQuery,
          documents: documents.map((document) => document.text),
          top_n: top,
        }),
        signal: AbortSignal.timeout(timeoutMs),
        errorMessage: (status) =>
          `${options.provider} reranking request failed with HTTP ${status}`,
      },
    );
    return parseResults(payload.results, documents, top, options.provider);
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
