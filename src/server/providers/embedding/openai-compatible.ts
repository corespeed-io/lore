import type { EmbeddingProvider, EmbeddingTask } from "@corespeed/lore-core";
import OpenAI, { type ClientOptions } from "openai";
import type { EmbeddingConfiguration, EmbeddingProviderName } from "./config";

const OPENAI_BASE_URL = "https://api.openai.com";
/** Vercel AI Gateway's OpenAI-compatible surface; `/v1/embeddings` is appended. */
const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
const OPENAI_REQUEST_BATCH_SIZE = 100;

export interface OpenAICompatibleEmbeddingOptions {
  apiKey: string;
  baseUrl?: string;
  batchSize?: number;
  fetch?: ClientOptions["fetch"];
  maxRetries?: number;
  timeoutMs?: number;
}

interface EmbeddingAdapter {
  provider: Extract<EmbeddingProviderName, "openai" | "vercel">;
  /** Human-readable service name used by every error this adapter raises. */
  label: string;
  defaultBaseUrl: string;
  credentialError: string;
  validateModel?(model: string): void;
}

interface OpenAIEmbeddingResponse {
  data?: unknown;
}

function apiBaseUrl(baseUrl: string, label: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} embedding base URL must use http or https`);
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
  label: string,
): number[][] {
  if (!Array.isArray(payload.data) || payload.data.length !== expectedCount) {
    throw new Error(`${label} returned the wrong number of embeddings`);
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
      throw new Error(`${label} returned an invalid embedding`);
    }
    embeddings[index as number] = embedding as number[];
  }
  if (embeddings.some((embedding) => embedding === undefined)) {
    throw new Error(`${label} returned an invalid embedding index`);
  }
  return embeddings as number[][];
}

function createEmbeddingProvider(
  adapter: EmbeddingAdapter,
  configuration: EmbeddingConfiguration,
  options: OpenAICompatibleEmbeddingOptions,
): EmbeddingProvider {
  if (configuration.provider !== adapter.provider) {
    throw new Error(`${adapter.label} adapter requires provider=${adapter.provider}`);
  }
  adapter.validateModel?.(configuration.model);
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error(adapter.credentialError);
  const timeoutMs = Math.max(1_000, boundedInteger(options.timeoutMs, 120_000, 600_000));
  const client = new OpenAI({
    apiKey,
    adminAPIKey: null,
    organization: null,
    project: null,
    baseURL: apiBaseUrl(options.baseUrl ?? adapter.defaultBaseUrl, adapter.label),
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
              throw new Error(`${adapter.label} embedding request failed (${error.status})`);
            }
            throw new Error(`${adapter.label} embedding request failed`);
          });
        embeddings.push(
          ...embeddingsFrom(response, batch.length, configuration.dimensions, adapter.label),
        );
      }
      return embeddings;
    },
  };
}

export function createOpenAIEmbeddingProvider(
  configuration: EmbeddingConfiguration,
  options: OpenAICompatibleEmbeddingOptions,
): EmbeddingProvider {
  return createEmbeddingProvider(
    {
      provider: "openai",
      label: "OpenAI",
      defaultBaseUrl: OPENAI_BASE_URL,
      credentialError: "OPENAI_API_KEY is required for the OpenAI embedding provider",
    },
    configuration,
    options,
  );
}

/**
 * Vercel AI Gateway routes one credential to many upstream embedding models over
 * OpenAI's `/v1/embeddings` contract. The gateway maps the root-level
 * `dimensions` field onto each upstream provider's own field, so Lore's 1024
 * protocol invariant travels unchanged; a model that cannot serve 1024 values
 * fails this adapter's width check rather than silently storing a short vector.
 */
export function createVercelAIGatewayEmbeddingProvider(
  configuration: EmbeddingConfiguration,
  options: OpenAICompatibleEmbeddingOptions,
): EmbeddingProvider {
  return createEmbeddingProvider(
    {
      provider: "vercel",
      label: "Vercel AI Gateway",
      defaultBaseUrl: VERCEL_AI_GATEWAY_BASE_URL,
      credentialError:
        "AI_GATEWAY_API_KEY is required for the Vercel AI Gateway embedding provider",
      validateModel(model) {
        if (!/^[^\s/]+\/\S+$/u.test(model)) {
          throw new Error(
            "Vercel AI Gateway models are creator/model ids such as openai/text-embedding-3-small",
          );
        }
      },
    },
    configuration,
    options,
  );
}
