import type { EmbeddingConfiguration } from "../embedding-config";
import type { EmbeddingProvider, EmbeddingTask } from "../memory";
import { postEmbeddingJson, type RemoteEmbeddingRequestOptions } from "./http";

const GOOGLE_EMBEDDING_BASE_URL = "https://generativelanguage.googleapis.com";
const GOOGLE_REQUEST_BATCH_SIZE = 100;
const GOOGLE_SUPPORTED_MODELS = ["gemini-embedding-2", "gemini-embedding-001"] as const;

export interface GoogleEmbeddingOptions extends RemoteEmbeddingRequestOptions {
  apiKey: string;
  baseUrl?: string;
  batchSize?: number;
}

interface GoogleEmbeddingResponse {
  embeddings?: unknown;
}

function modelResource(model: string): string {
  const name = model.trim().replace(/^models\//, "");
  if (!name || name.includes("/")) throw new Error("Invalid Google embedding model");
  return `models/${name}`;
}

function endpoint(baseUrl: string, model: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Google embedding base URL must use http or https");
  }
  const base = `${url.toString().replace(/\/$/, "")}/`;
  return new URL(`v1beta/${modelResource(model)}:batchEmbedContents`, base).toString();
}

function taskType(task: EmbeddingTask): "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" {
  return task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
}

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return GOOGLE_REQUEST_BATCH_SIZE;
  }
  return Math.min(value, GOOGLE_REQUEST_BATCH_SIZE);
}

function supportedModel(model: string): (typeof GOOGLE_SUPPORTED_MODELS)[number] {
  const name = modelResource(model).slice("models/".length);
  if (!GOOGLE_SUPPORTED_MODELS.some((supported) => supported === name)) {
    throw new Error(`Unsupported Google embedding model: ${name}`);
  }
  return name as (typeof GOOGLE_SUPPORTED_MODELS)[number];
}

function retrievalText(
  text: string,
  task: EmbeddingTask,
  model: (typeof GOOGLE_SUPPORTED_MODELS)[number],
): string {
  if (model !== "gemini-embedding-2") return text;
  return task === "query" ? `task: search result | query: ${text}` : `title: none | text: ${text}`;
}

function embeddingsFrom(
  payload: GoogleEmbeddingResponse,
  expectedCount: number,
  dimensions: number,
): number[][] {
  if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== expectedCount) {
    throw new Error("Google returned the wrong number of embeddings");
  }
  return payload.embeddings.map((embedding) => {
    const values =
      typeof embedding === "object" && embedding !== null && "values" in embedding
        ? (embedding as { values?: unknown }).values
        : undefined;
    if (
      !Array.isArray(values) ||
      values.length !== dimensions ||
      values.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error("Google returned an invalid embedding");
    }
    return values as number[];
  });
}

export function createGoogleEmbeddingProvider(
  configuration: EmbeddingConfiguration,
  options: GoogleEmbeddingOptions,
): EmbeddingProvider {
  if (configuration.provider !== "google") {
    throw new Error("Google adapter requires provider=google");
  }
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is required for the Google embedding provider");
  const canonicalModel = supportedModel(configuration.model);
  const model = modelResource(canonicalModel);
  const url = endpoint(options.baseUrl ?? GOOGLE_EMBEDDING_BASE_URL, canonicalModel);
  const batchSize = boundedBatchSize(options.batchSize);

  return {
    provider: configuration.provider,
    model: canonicalModel,
    dimensions: configuration.dimensions,
    revision: configuration.revision,
    async embed(texts: string[], task: EmbeddingTask): Promise<number[][]> {
      if (!texts.length) return [];
      const embeddings: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += batchSize) {
        const batch = texts.slice(offset, offset + batchSize);
        const response = await postEmbeddingJson({
          url,
          service: "Google",
          headers: { "x-goog-api-key": apiKey },
          body: {
            requests: batch.map((text) => ({
              model,
              content: { parts: [{ text: retrievalText(text, task, canonicalModel) }] },
              embedContentConfig: {
                outputDimensionality: configuration.dimensions,
                ...(canonicalModel === "gemini-embedding-001" ? { taskType: taskType(task) } : {}),
              },
            })),
          },
          options,
        });
        embeddings.push(
          ...embeddingsFrom(
            (await response.json()) as GoogleEmbeddingResponse,
            batch.length,
            configuration.dimensions,
          ),
        );
      }
      return embeddings;
    },
  };
}
