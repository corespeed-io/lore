import OpenAI, { type ClientOptions } from "openai";
import type { ConfiguredQueryPlanningProvider } from "../metadata";
import { parsePlannedQueries } from "./parse";

const DEFAULT_INSTRUCTION = `Rewrite a memory recall question into distinct evidence-retrieval queries.
For counts, comparisons, temporal reasoning, or multi-hop questions, create separate queries for each fact needed.
Preserve exact names, dates, products, and places. Do not answer the question.`;
const JSON_OUTPUT_INSTRUCTION = "Return only a JSON object with a queries array.";

/**
 * Vercel AI Gateway documents `json_schema` and its own legacy `json` format,
 * not OpenAI's `json_object` mode, and routes to providers whose native
 * structured output is schema-shaped. The planner therefore states its contract
 * as a schema on that surface and keeps `json_object` for OpenAI and vLLM.
 */
const QUERY_PLAN_RESPONSE_SCHEMA = {
  type: "object",
  properties: { queries: { type: "array", items: { type: "string" } } },
  required: ["queries"],
  additionalProperties: false,
} as const;

export type OpenAICompatibleQueryPlanningProviderName = "openai" | "vercel" | "vllm";

export interface OpenAICompatibleQueryPlanningOptions {
  provider: OpenAICompatibleQueryPlanningProviderName;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  instruction?: string;
  timeoutMs?: number;
  fetch?: ClientOptions["fetch"];
}

interface ChatCompletionResponse {
  choices?: unknown;
}

const PROVIDER_LABELS: Record<OpenAICompatibleQueryPlanningProviderName, string> = {
  openai: "OpenAI",
  vercel: "Vercel AI Gateway",
  vllm: "vLLM",
};

const DEFAULT_BASE_URLS: Record<OpenAICompatibleQueryPlanningProviderName, string> = {
  openai: "https://api.openai.com/v1",
  vercel: "https://ai-gateway.vercel.sh/v1",
  vllm: "http://127.0.0.1:8000/v1",
};

function apiBaseUrl(baseUrl: string, provider: OpenAICompatibleQueryPlanningProviderName): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("query planner base URL must use http or https");
  }
  if (
    provider !== "vllm" &&
    url.protocol !== "https:" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost"
  ) {
    throw new Error(
      `${PROVIDER_LABELS[provider]} query planner base URL must use https outside localhost`,
    );
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
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
): ConfiguredQueryPlanningProvider {
  const model = options.model.trim();
  if (!model) throw new Error("LORE_QUERY_PLANNER_MODEL is required");
  const configuredInstruction = options.instruction?.trim() || DEFAULT_INSTRUCTION;
  const instruction = `${configuredInstruction}\n${JSON_OUTPUT_INSTRUCTION}`;
  const timeoutMs = positiveInteger(options.timeoutMs, 30_000);
  const baseURL = apiBaseUrl(
    options.baseUrl ?? DEFAULT_BASE_URLS[options.provider],
    options.provider,
  );
  const apiKey = options.apiKey?.trim();
  if (options.provider !== "vllm" && !apiKey) {
    throw new Error(
      `LORE_QUERY_PLANNER_API_KEY is required for ${PROVIDER_LABELS[options.provider]}`,
    );
  }
  if (options.provider === "vercel" && !/^[^\s/]+\/\S+$/u.test(model)) {
    throw new Error("Vercel AI Gateway models are creator/model ids such as openai/gpt-5.1-mini");
  }
  const client = new OpenAI({
    apiKey: apiKey || "not-required",
    adminAPIKey: null,
    organization: null,
    project: null,
    baseURL,
    timeout: timeoutMs,
    maxRetries: 0,
    ...(apiKey ? {} : { defaultHeaders: { Authorization: null } }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    provider: options.provider,
    model,
    revision: "lore-query-planning-v2",
    transport: "openai-chat-completions-v1",
    instruction,
    decoding: { temperature: 0, maximumOutputTokens: 256 },
    async plan({ query, maxQueries }) {
      if (!query.trim() || maxQueries < 1) return [];
      const payload = await client.chat.completions
        .create({
          model,
          temperature: 0,
          ...(options.provider === "openai" ? { max_completion_tokens: 256 } : { max_tokens: 256 }),
          response_format:
            options.provider === "vercel"
              ? {
                  type: "json_schema",
                  json_schema: { name: "lore_query_plan", schema: QUERY_PLAN_RESPONSE_SCHEMA },
                }
              : { type: "json_object" },
          messages: [
            { role: "system", content: instruction },
            {
              role: "user",
              content: `Question: ${query}\nMaximum retrieval queries: ${maxQueries}`,
            },
          ],
        })
        .catch((error: unknown) => {
          if (error instanceof OpenAI.APIError && error.status !== undefined) {
            throw new Error(`query planner request failed with HTTP ${error.status}`);
          }
          throw new Error("query planner request failed");
        });
      return parsePlannedQueries(responseText(payload), maxQueries);
    },
  };
}
