import type { EmbeddingProvider, EmbeddingTask } from "@corespeed/lore-core";
import OpenAI, { type ClientOptions } from "openai";
import type { EmbeddingConfiguration } from "./config";

const OPENAI_BASE_URL = "https://api.openai.com";
const OPENAI_REQUEST_BATCH_SIZE = 100;

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  baseUrl?: string;
  batchSize?: number;
  fetch?: ClientOptions["fetch"];
  maxRetries?: number;
  timeoutMs?: number;
}

interface OpenAIEmbeddingResponse {
  data?: unknown;
}

function apiBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OpenAI embedding base URL must use http or https");
  }
  const base = `${url.toString().replace(/\/$/, "")}/`;
  return new URL("v1", base).toString();
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : fallback;
}

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return OPENAI_REQUEST_BATCH_SIZE;
  }
  return Math.min(value, OPENAI_REQUEST_BATCH_SIZE);
}

function embeddingsFrom(
  payload: OpenAIEmbeddingResponse,
  expectedCount: number,
  dimensions: number,
): number[][] {
  if (!Array.isArray(payload.data) || payload.data.length !== expectedCount) {
    throw new Error("OpenAI returned the wrong number of embeddings");
  }
  const embeddings: Array<number[] | undefined> = Array.from({ length: expectedCount });
  for (const item of payload.data) {
    const index =
      typeof item === "object" && item !== null && "index" in item
        ? (item as { index?: unknown }).index
        : undefined;
    const embedding =
      typeof item === "object" && item !== null && "embedding" in item
        ? (item as { embedding?: unknown }).embedding
        : undefined;
    if (
      !Number.isInteger(index) ||
      (index as number) < 0 ||
      (index as number) >= expectedCount ||
      embeddings[index as number] !== undefined ||
      !Array.isArray(embedding) ||
      embedding.length !== dimensions ||
      embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error("OpenAI returned an invalid embedding");
    }
    embeddings[index as number] = embedding as number[];
  }
  if (embeddings.some((embedding) => embedding === undefined)) {
    throw new Error("OpenAI returned an invalid embedding index");
  }
  return embeddings as number[][];
}

export function createOpenAIEmbeddingProvider(
  configuration: EmbeddingConfiguration,
  options: OpenAIEmbeddingOptions,
): EmbeddingProvider {
  if (configuration.provider !== "openai") {
    throw new Error("OpenAI adapter requires provider=openai");
  }
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for the OpenAI embedding provider");
  const timeoutMs = Math.max(1_000, boundedInteger(options.timeoutMs, 120_000, 600_000));
  const client = new OpenAI({
    apiKey,
    adminAPIKey: null,
    organization: null,
    project: null,
    baseURL: apiBaseUrl(options.baseUrl ?? OPENAI_BASE_URL),
    timeout: timeoutMs,
    maxRetries: boundedInteger(options.maxRetries, 2, 5),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const batchSize = boundedBatchSize(options.batchSize);

  return {
    provider: configuration.provider,
    model: configuration.model,
    dimensions: configuration.dimensions,
    revision: configuration.revision,
    async embed(texts: string[], _task: EmbeddingTask): Promise<number[][]> {
      if (!texts.length) return [];
      const embeddings: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += batchSize) {
        const batch = texts.slice(offset, offset + batchSize);
        const response = await client.embeddings
          .create({
            input: batch,
            model: configuration.model,
            dimensions: configuration.dimensions,
            encoding_format: "float",
          })
          .catch((error: unknown) => {
            if (error instanceof OpenAI.APIError && error.status !== undefined) {
              throw new Error(`OpenAI embedding request failed (${error.status})`);
            }
            throw new Error("OpenAI embedding request failed");
          });
        embeddings.push(...embeddingsFrom(response, batch.length, configuration.dimensions));
      }
      return embeddings;
    },
  };
}
