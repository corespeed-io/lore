import { readBoundedResponseJson } from "../provider-response";
import type { QueryPlanningProvider } from "../query-planning";
import { parsePlannedQueries } from "./parse";

const DEFAULT_INSTRUCTION = `Rewrite a memory recall question into distinct evidence-retrieval queries.
For counts, comparisons, temporal reasoning, or multi-hop questions, create separate queries for each fact needed.
Preserve exact names, dates, products, and places. Do not answer the question.`;

export interface OllamaQueryPlanningOptions {
  model: string;
  baseUrl?: string;
  instruction?: string;
  keepAlive?: string | number;
  contextWindowTokens?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface OllamaChatResponse {
  message?: unknown;
  done?: unknown;
  remote_model?: unknown;
  remote_host?: unknown;
}

function endpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Ollama query planner base URL must use http or https");
  }
  return new URL("api/chat", `${url.toString().replace(/\/$/, "")}/`).toString();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createOllamaQueryPlanningProvider(
  options: OllamaQueryPlanningOptions,
): QueryPlanningProvider {
  const model = options.model.trim();
  if (!model) throw new Error("LORE_QUERY_PLANNER_MODEL is required");
  const instruction = options.instruction?.trim() || DEFAULT_INSTRUCTION;
  const timeoutMs = positiveInteger(options.timeoutMs, 30_000);
  const contextWindowTokens = positiveInteger(options.contextWindowTokens, 4096);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const url = endpoint(options.baseUrl ?? "http://127.0.0.1:11434");
  const keepAlive = options.keepAlive ?? 0;

  return {
    provider: "ollama",
    model,
    revision: "lore-query-planning-v2",
    transport: "ollama-chat-v1",
    instruction,
    decoding: {
      temperature: 0,
      topP: 1,
      topK: 1,
      seed: 42,
      thinking: false,
      contextWindowTokens,
      maximumOutputTokens: 256,
    },
    keepAlive,
    async plan({ query, maxQueries }) {
      if (!query.trim() || maxQueries < 1) return [];
      const response = await fetchImplementation(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          keep_alive: keepAlive,
          format: {
            type: "object",
            properties: {
              queries: {
                type: "array",
                items: { type: "string" },
                maxItems: maxQueries,
              },
            },
            required: ["queries"],
            additionalProperties: false,
          },
          options: {
            temperature: 0,
            seed: 42,
            top_p: 1,
            top_k: 1,
            num_ctx: contextWindowTokens,
            num_predict: 256,
          },
          messages: [
            { role: "system", content: instruction },
            {
              role: "user",
              content: `Question: ${query}\nMaximum retrieval queries: ${maxQueries}`,
            },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Ollama query planner request failed with HTTP ${response.status}`);
      }
      const payload = await readBoundedResponseJson<OllamaChatResponse>(response);
      if (payload.done !== true) {
        throw new Error("Ollama query planner returned an incomplete response");
      }
      if (optionalString(payload.remote_model) || optionalString(payload.remote_host)) {
        throw new Error("Ollama query planner refuses a remote/cloud response");
      }
      const content =
        typeof payload.message === "object" &&
        payload.message !== null &&
        "content" in payload.message
          ? (payload.message as { content?: unknown }).content
          : undefined;
      return parsePlannedQueries(content, maxQueries);
    },
  };
}
