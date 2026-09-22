import OpenAI, { type ClientOptions } from "openai";
import {
  assertVercelAIGatewayModel,
  VERCEL_AI_GATEWAY_OPENAI_BASE_URL,
} from "@/server/providers/vercel-ai-gateway";
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

/**
 * What differs between the OpenAI-compatible planner surfaces. `selfHosted`
 * covers the two policies an operator-run endpoint relaxes together: it may be
 * plaintext loopback, and it needs no deployment credential.
 */
interface PlannerSurface {
  label: string;
  defaultBaseUrl: string;
  selfHosted: boolean;
  /** OpenAI renamed this parameter; the gateway and vLLM document `max_tokens`. */
  outputTokenParameter: "max_completion_tokens" | "max_tokens";
  structuredOutput: "json_object" | "json_schema";
  /** Set only by the gateway, whose model ids are `creator/model` slugs. */
  gatewayModelExample?: string;
}

const PLANNER_SURFACES: Record<OpenAICompatibleQueryPlanningProviderName, PlannerSurface> = {
  openai: {
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    selfHosted: false,
    outputTokenParameter: "max_completion_tokens",
    structuredOutput: "json_object",
  },
  vercel: {
    label: "Vercel AI Gateway",
    defaultBaseUrl: VERCEL_AI_GATEWAY_OPENAI_BASE_URL,
    selfHosted: false,
    outputTokenParameter: "max_tokens",
    structuredOutput: "json_schema",
    gatewayModelExample: "openai/gpt-6-astra",
  },
  vllm: {
    label: "vLLM",
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
    selfHosted: true,
    outputTokenParameter: "max_tokens",
    structuredOutput: "json_object",
  },
};

function apiBaseUrl(baseUrl: string, surface: PlannerSurface): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("query planner base URL must use http or https");
  }
  if (
    !surface.selfHosted &&
    url.protocol !== "https:" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost"
  ) {
    throw new Error(`${surface.label} query planner base URL must use https outside localhost`);
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
  const surface = PLANNER_SURFACES[options.provider];
  const baseURL = apiBaseUrl(options.baseUrl ?? surface.defaultBaseUrl, surface);
  const apiKey = options.apiKey?.trim();
  if (!surface.selfHosted && !apiKey) {
    throw new Error(`LORE_QUERY_PLANNER_API_KEY is required for ${surface.label}`);
  }
  if (surface.gatewayModelExample) assertVercelAIGatewayModel(model, surface.gatewayModelExample);
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
          [surface.outputTokenParameter]: 256,
          response_format:
            surface.structuredOutput === "json_schema"
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
