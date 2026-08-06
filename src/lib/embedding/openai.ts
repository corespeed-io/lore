import type { EmbeddingConfiguration } from "../embedding-config";
import type { EmbeddingProvider, EmbeddingTask } from "../memory";
import { postEmbeddingJson, type RemoteEmbeddingRequestOptions } from "./http";

const OPENAI_BASE_URL = "https://api.openai.com";
const OPENAI_REQUEST_BATCH_SIZE = 100;

export interface OpenAIEmbeddingOptions extends RemoteEmbeddingRequestOptions {
  apiKey: string;
  baseUrl?: string;
  batchSize?: number;
}

interface OpenAIEmbeddingResponse {
  data?: unknown;
}

function endpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OpenAI embedding base URL must use http or https");
  }
  const base = `${url.toString().replace(/\/$/, "")}/`;
  return new URL("v1/embeddings", base).toString();
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
  const url = endpoint(options.baseUrl ?? OPENAI_BASE_URL);
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
        const response = await postEmbeddingJson({
          url,
          service: "OpenAI",
          headers: { authorization: `Bearer ${apiKey}` },
          body: {
            input: batch,
            model: configuration.model,
            dimensions: configuration.dimensions,
            encoding_format: "float",
          },
          options,
        });
        embeddings.push(
          ...embeddingsFrom(
            (await response.json()) as OpenAIEmbeddingResponse,
            batch.length,
            configuration.dimensions,
          ),
        );
      }
      return embeddings;
    },
  };
}
