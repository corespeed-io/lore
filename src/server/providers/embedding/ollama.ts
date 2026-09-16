import type { EmbeddingProvider, EmbeddingTask } from "@corespeed/lore-core";
import { Ollama } from "ollama/browser";
import type { EmbeddingConfiguration } from "./config";
import { QWEN3_EMBEDDING_PROTOCOL_REVISION } from "./config";

export interface OllamaEmbeddingOptions {
  baseUrl?: string;
  batchSize?: number;
  keepAlive?: string | number;
  fetch?: typeof fetch;
}

interface OllamaEmbedResponse {
  embeddings?: unknown;
}

export const QWEN3_RETRIEVAL_INSTRUCTION =
  "Given a web search query, retrieve relevant passages that answer the query";
const OLLAMA_REQUEST_BATCH_SIZE = 256;

function retrievalText(text: string, task: EmbeddingTask, revision: string): string {
  if (task === "document" || revision !== QWEN3_EMBEDDING_PROTOCOL_REVISION) return text;
  return `Instruct: ${QWEN3_RETRIEVAL_INSTRUCTION}\nQuery:${text}`;
}

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return OLLAMA_REQUEST_BATCH_SIZE;
  }
  return Math.min(value, OLLAMA_REQUEST_BATCH_SIZE);
}

function ollamaHost(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OLLAMA_BASE_URL must use http or https");
  }
  if (url.hostname === "ollama.com") {
    throw new Error("Ollama embeddings require a self-hosted server; ollama.com is not supported");
  }
  return url.toString().replace(/\/$/, "");
}

function embeddingsFrom(payload: OllamaEmbedResponse, dimensions: number): number[][] {
  if (!Array.isArray(payload.embeddings)) {
    throw new Error("Ollama returned no embeddings");
  }
  return payload.embeddings.map((embedding) => {
    if (
      !Array.isArray(embedding) ||
      embedding.length !== dimensions ||
      embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error("Ollama returned an invalid embedding");
    }
    return embedding as number[];
  });
}

export function createOllamaEmbeddingProvider(
  configuration: EmbeddingConfiguration,
  options: OllamaEmbeddingOptions = {},
): EmbeddingProvider {
  if (configuration.provider !== "ollama") {
    throw new Error("Ollama adapter requires provider=ollama");
  }
  const client = new Ollama({
    host: ollamaHost(options.baseUrl ?? "http://127.0.0.1:11434"),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const batchSize = boundedBatchSize(options.batchSize);
  return {
    provider: configuration.provider,
    model: configuration.model,
    dimensions: configuration.dimensions,
    revision: configuration.revision,
    async embed(texts: string[], task: EmbeddingTask): Promise<number[][]> {
      if (!texts.length) return [];
      const embeddings: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += batchSize) {
        const batch = texts.slice(offset, offset + batchSize);
        const response = await client
          .embed({
            model: configuration.model,
            input: batch.map((text) => retrievalText(text, task, configuration.revision)),
            dimensions: configuration.dimensions,
            keep_alive: offset + batch.length < texts.length ? "30s" : (options.keepAlive ?? 0),
          })
          .catch((error: unknown) => {
            if (
              error instanceof Error &&
              "status_code" in error &&
              typeof error.status_code === "number"
            ) {
              throw new Error(`Ollama embedding request failed (${error.status_code})`);
            }
            throw new Error("Ollama embedding request failed");
          });
        const batchEmbeddings = embeddingsFrom(response, configuration.dimensions);
        if (batchEmbeddings.length !== batch.length) {
          throw new Error("Ollama returned the wrong number of embeddings");
        }
        embeddings.push(...batchEmbeddings);
      }
      return embeddings;
    },
  };
}
