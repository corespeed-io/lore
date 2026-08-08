import type { QueryPlanningProvider } from "../query-planning";
import { parsePlannedQueries } from "./parse";

const DEFAULT_INSTRUCTION = `Rewrite a memory recall question into distinct evidence-retrieval queries.
For counts, comparisons, temporal reasoning, or multi-hop questions, create separate queries for each fact needed.
Preserve exact names, dates, products, and places. Do not answer the question.
Return only a JSON object with a queries array.`;

export interface OpenAICompatibleQueryPlanningOptions {
  provider: "openai" | "vllm";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  instruction?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface ChatCompletionResponse {
  choices?: unknown;
}

function endpoint(baseUrl: string, provider: "openai" | "vllm"): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("query planner base URL must use http or https");
  }
  if (
    provider === "openai" &&
    url.protocol !== "https:" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost"
  ) {
    throw new Error("OpenAI query planner base URL must use https outside localhost");
  }
  return new URL("chat/completions", `${url.toString().replace(/\/$/, "")}/`).toString();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function responseText(payload: ChatCompletionResponse): unknown {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0];
  const message =
    typeof first === "object" && first !== null && "message" in first
      ? (first as { message?: unknown }).message
      : undefined;
  const content =
    typeof message === "object" && message !== null && "content" in message
      ? (message as { content?: unknown }).content
      : undefined;
  return content;
}

export function createOpenAICompatibleQueryPlanningProvider(
  options: OpenAICompatibleQueryPlanningOptions,
): QueryPlanningProvider {
  const model = options.model.trim();
  if (!model) throw new Error("LORE_QUERY_PLANNER_MODEL is required");
  const instruction = options.instruction?.trim() || DEFAULT_INSTRUCTION;
  const timeoutMs = positiveInteger(options.timeoutMs, 30_000);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const defaultBaseUrl =
    options.provider === "openai" ? "https://api.openai.com/v1" : "http://127.0.0.1:8000/v1";
  const url = endpoint(options.baseUrl ?? defaultBaseUrl, options.provider);
  const apiKey = options.apiKey?.trim();
  if (options.provider === "openai" && !apiKey) {
    throw new Error("LORE_QUERY_PLANNER_API_KEY is required for OpenAI");
  }

  return {
    provider: options.provider,
    model,
    revision: "lore-query-planning-v1",
    transport: "openai-chat-completions-v1",
    instruction,
    decoding: { temperature: 0, maximumOutputTokens: 256 },
    async plan({ query, maxQueries }) {
      if (!query.trim() || maxQueries < 1) return [];
      const response = await fetchImplementation(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          ...(options.provider === "openai" ? { max_completion_tokens: 256 } : { max_tokens: 256 }),
          response_format: { type: "json_object" },
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
        throw new Error(`query planner request failed with HTTP ${response.status}`);
      }
      return parsePlannedQueries(
        responseText((await response.json()) as ChatCompletionResponse),
        maxQueries,
      );
    },
  };
}
