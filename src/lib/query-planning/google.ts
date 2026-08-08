import { readBoundedResponseJson } from "../provider-response";
import type { QueryPlanningProvider } from "../query-planning";
import { parsePlannedQueries } from "./parse";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_INSTRUCTION = `Rewrite a memory recall question into distinct evidence-retrieval queries.
For counts, comparisons, temporal reasoning, or multi-hop questions, create separate queries for each fact needed.
Preserve exact names, dates, products, and places. Do not answer the question.`;

export interface GoogleQueryPlanningOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  instruction?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface GoogleInteractionResponse {
  status?: unknown;
  steps?: unknown;
}

function endpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Google query planner base URL must use https");
  }
  return new URL("interactions", `${url.toString().replace(/\/$/, "")}/`).toString();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function responseText(payload: GoogleInteractionResponse): unknown {
  if (payload.status !== "completed" || !Array.isArray(payload.steps)) {
    throw new Error("Google query planner returned an incomplete interaction");
  }
  for (let index = payload.steps.length - 1; index >= 0; index -= 1) {
    const step = payload.steps[index];
    if (typeof step !== "object" || step === null || !("type" in step)) continue;
    if ((step as { type?: unknown }).type !== "model_output") continue;
    const content = "content" in step ? (step as { content?: unknown }).content : undefined;
    if (!Array.isArray(content)) continue;
    const text = content.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        (item as { type?: unknown }).type === "text",
    );
    if (typeof text === "object" && text !== null && "text" in text) {
      return (text as { text?: unknown }).text;
    }
  }
  return undefined;
}

export function createGoogleQueryPlanningProvider(
  options: GoogleQueryPlanningOptions,
): QueryPlanningProvider {
  const model = options.model.trim();
  if (!model) throw new Error("LORE_QUERY_PLANNER_MODEL is required");
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY or LORE_QUERY_PLANNER_API_KEY is required");
  const instruction = options.instruction?.trim() || DEFAULT_INSTRUCTION;
  const timeoutMs = positiveInteger(options.timeoutMs, 30_000);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const url = endpoint(options.baseUrl ?? DEFAULT_BASE_URL);

  return {
    provider: "google",
    model,
    revision: "lore-query-planning-v1",
    transport: "google-interactions-v1beta",
    instruction,
    decoding: { temperature: 0, maximumOutputTokens: 256 },
    async plan({ query, maxQueries }) {
      if (!query.trim() || maxQueries < 1) return [];
      const response = await fetchImplementation(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model,
          input: `Question: ${query}\nMaximum retrieval queries: ${maxQueries}`,
          system_instruction: instruction,
          store: false,
          stream: false,
          generation_config: { temperature: 0, max_output_tokens: 256 },
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: {
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
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Google query planner request failed with HTTP ${response.status}`);
      }
      return parsePlannedQueries(
        responseText(await readBoundedResponseJson<GoogleInteractionResponse>(response)),
        maxQueries,
      );
    },
  };
}
