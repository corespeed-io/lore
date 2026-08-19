import type { EmbeddingConfiguration } from "../embedding-config";
import { QWEN3_EMBEDDING_PROTOCOL_REVISION } from "../embedding-config";
import type { EmbeddingProvider, EmbeddingTask } from "../memory";
import { readBoundedResponseJson, readBoundedResponseText } from "../provider-response";

export interface OllamaEmbeddingOptions {
  baseUrl?: string;
  batchSize?: number;
  keepAlive?: string | number;
  timeoutMs?: number;
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

function endpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OLLAMA_BASE_URL must use http or https");
  }
  return new URL("api/embed", `${url.toString().replace(/\/$/, "")}/`).toString();
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
  const fetchImplementation = options.fetch ?? fetch;
  const url = endpoint(options.baseUrl ?? "http://127.0.0.1:11434");
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 120_000, 600_000));
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
        const response = await fetchImplementation(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: configuration.model,
            input: batch.map((text) => retrievalText(text, task, configuration.revision)),
            dimensions: configuration.dimensions,
            keep_alive: offset + batch.length < texts.length ? "30s" : (options.keepAlive ?? 0),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          const detail = (await readBoundedResponseText(response).catch(() => ""))
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 300);
          throw new Error(
            `Ollama embedding request failed (${response.status})${detail ? `: ${detail}` : ""}`,
          );
        }
        const batchEmbeddings = embeddingsFrom(
          await readBoundedResponseJson<OllamaEmbedResponse>(response),
          configuration.dimensions,
        );
        if (batchEmbeddings.length !== batch.length) {
          throw new Error("Ollama returned the wrong number of embeddings");
        }
        embeddings.push(...batchEmbeddings);
      }
      return embeddings;
    },
  };
}
