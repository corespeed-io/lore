import { providerHttpError, readBoundedResponseJson } from "@corespeed/lore-core";
import { extractBoxedAnswer } from "../../src/lib/answer-evaluation";

export type BenchmarkJudgeKind = "abstention" | "gotchas";

export interface BenchmarkJudgeResult {
  correct: boolean;
  label: 0 | 1;
  reason: string;
  raw: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface BenchmarkJudgeProvider {
  provider: string;
  model: string;
  revision: string;
  reasoningEffort: "low" | "medium" | "high" | null;
  judge(input: {
    kind: BenchmarkJudgeKind;
    question: string;
    referenceAnswer: string;
    modelFullResponse: string;
    modelFinalAnswer?: string;
  }): Promise<BenchmarkJudgeResult>;
}

interface JudgeOptions {
  provider: "google" | "openai" | "vllm";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  reasoningEffort?: "low" | "medium" | "high";
  timeoutMs?: number;
  maximumOutputTokens?: number;
  fetch?: typeof globalThis.fetch;
}

// Prompts are pinned to evaluation/qa_eval_metrics.py at this upstream commit.
export const LONGMEMEVAL_V2_JUDGE_REVISION =
  "longmemeval-v2-judge@ef67f10aacd9080c75aeb2dd527a0af25dc26f1b";

const ABSTENTION_SYSTEM_PROMPT =
  "You are a strict grader for flawed-premise (abstention) questions. " +
  "Judge whether a model answer correctly identifies that the question premise is wrong, " +
  "consistent with the reference answer. " +
  "If the model follows the flawed premise and gives a concrete answer under that premise, " +
  "it must be graded 0. " +
  "If the model's final answer is just UNKNOWN / cannot determine without identifying the flaw, grade 0. " +
  "If the model is contradictory (both rejects premise and also gives a concrete premise-following answer), grade 0. " +
  "Paraphrases are allowed when they preserve the same core flaw described by the reference answer.";

const GOTCHAS_SYSTEM_PROMPT =
  "You are a strict grader for gotchas-style insight questions. " +
  "The reference answer describes the key insight(s). " +
  "Grade 1 if the model response includes at least one correct insight point from the reference answer " +
  "(paraphrase allowed), and does not contradict any reference point. " +
  "If the model's direction is wrong, or it contains contradictions against any reference point, grade 0. " +
  "If the model gives multiple points, partial coverage is enough for 1 as long as no contradictions appear.";

export interface BenchmarkJudgeMessage {
  role: "system" | "user";
  content: string;
}

export function buildLongMemEvalV2JudgeMessages(input: {
  kind: BenchmarkJudgeKind;
  question: string;
  referenceAnswer: string;
  modelFullResponse: string;
  modelFinalAnswer: string;
}): BenchmarkJudgeMessage[] {
  const common =
    `Question:\n${input.question.trim()}\n\n` +
    `Reference answer (${input.kind === "abstention" ? "the expected flaw-aware conclusion" : "insight points"}):\n` +
    `${input.referenceAnswer.trim()}\n\n` +
    `Model full response:\n${input.modelFullResponse.trim()}\n\n` +
    `Model extracted final answer:\n${input.modelFinalAnswer.trim()}\n\n`;
  if (input.kind === "abstention") {
    return [
      { role: "system", content: ABSTENTION_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "Evaluate whether the model correctly handled a flawed-premise question.\n\n" +
          common +
          "Scoring rubric:\n" +
          "- Label 1 only if the model clearly identifies the flawed premise and reaches a conclusion equivalent to the reference answer.\n" +
          "- Label 1 also if the model explicitly says it lacks access to the user's specific live environment/instance/configuration and therefore cannot verify, provided it does not give a concrete premise-following answer.\n" +
          "- Label 0 if the model follows the flawed premise and gives a concrete answer under that premise.\n" +
          "- Label 0 for generic UNKNOWN/insufficient-info replies that do not identify a flaw and do not make the explicit environment-access limitation clear.\n" +
          "- Label 0 if contradictory.\n\n" +
          "Output JSON only:\n" +
          '{"label": 0 or 1, "reason": "short rationale"}',
      },
    ];
  }
  return [
    { role: "system", content: GOTCHAS_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        "Evaluate whether the model answer captures the gotcha insight.\n\n" +
        common +
        "Scoring rubric:\n" +
        "- Label 1 if the model includes at least one correct insight point from the reference answer (paraphrase acceptable), and does not contradict any reference point.\n" +
        "- Label 1 even if only part of a multi-point reference answer is covered, as long as there is no contradiction.\n" +
        "- Label 0 if direction is wrong (suggests opposite action/cause), even if some wording overlaps.\n" +
        "- Label 0 if any point in the model response contradicts any reference point.\n" +
        "- Label 0 if the response is irrelevant or generic without insight.\n\n" +
        "Output JSON only:\n" +
        '{"label": 0 or 1, "reason": "short rationale"}',
    },
  ];
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) return trimmed;
  const lines = trimmed.split("\n");
  return lines.length >= 3 ? lines.slice(1, -1).join("\n").trim() : trimmed;
}

export function parseLongMemEvalV2JudgeResponse(value: string): {
  label: 0 | 1;
  reason: string;
} {
  const cleaned = stripCodeFence(value);
  if (!cleaned) throw new Error("LongMemEval-V2 judge returned an empty response");
  const jsonMatch = cleaned.match(/\{.*\}/s)?.[0];
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch) as { label?: unknown; reason?: unknown };
      if (
        parsed.label === 0 ||
        parsed.label === 1 ||
        parsed.label === "0" ||
        parsed.label === "1"
      ) {
        return {
          label: Number(parsed.label) as 0 | 1,
          reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
        };
      }
    } catch {
      // Match the official evaluator's permissive label fallback below.
    }
  }
  const labelMatch =
    cleaned.match(/["']label["']\s*:\s*([01])/i) ?? cleaned.match(/\blabel\b\s*[:=]\s*([01])/i);
  if (!labelMatch) {
    throw new Error(`Could not parse LongMemEval-V2 judge response ${JSON.stringify(cleaned)}`);
  }
  return { label: Number(labelMatch[1]) as 0 | 1, reason: cleaned };
}

function endpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("benchmark judge base URL must use http or https");
  }
  return new URL(path, `${url.toString().replace(/\/$/, "")}/`).toString();
}

function usageToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : fallback;
}

function createOpenAICompatibleJudge(options: JudgeOptions): BenchmarkJudgeProvider {
  const model = options.model.trim();
  if (!model) throw new Error("LORE_BENCHMARK_JUDGE_MODEL is required");
  const apiKey = options.apiKey?.trim();
  if (options.provider === "openai" && !apiKey) {
    throw new Error("LORE_BENCHMARK_JUDGE_API_KEY or OPENAI_API_KEY is required for OpenAI");
  }
  const baseUrl =
    options.baseUrl ??
    (options.provider === "openai" ? "https://api.openai.com/v1" : "http://127.0.0.1:8002/v1");
  const url = endpoint(baseUrl, "chat/completions");
  const timeoutMs = positiveInteger(options.timeoutMs, 43_200_000, 1, 43_200_000);
  const maximumOutputTokens = positiveInteger(options.maximumOutputTokens, 4_096, 32, 8_192);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    provider: options.provider,
    model,
    revision: LONGMEMEVAL_V2_JUDGE_REVISION,
    reasoningEffort: options.reasoningEffort ?? "medium",
    async judge(input) {
      const messages = buildLongMemEvalV2JudgeMessages({
        ...input,
        modelFinalAnswer: input.modelFinalAnswer ?? extractBoxedAnswer(input.modelFullResponse),
      });
      const response = await fetchImplementation(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          max_completion_tokens: maximumOutputTokens,
          reasoning_effort: options.reasoningEffort ?? "medium",
          ...(options.provider === "openai" ? { store: false } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw await providerHttpError(
          response,
          `benchmark judge request failed with HTTP ${response.status}`,
        );
      }
      const payload = await readBoundedResponseJson<{
        choices?: unknown;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
      }>(response);
      const first = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
      const message =
        typeof first === "object" && first !== null && "message" in first
          ? (first as { message?: unknown }).message
          : undefined;
      const content =
        typeof message === "object" && message !== null && "content" in message
          ? (message as { content?: unknown }).content
          : undefined;
      if (typeof content !== "string") throw new Error("benchmark judge returned no response text");
      const judgement = parseLongMemEvalV2JudgeResponse(content);
      return {
        correct: judgement.label === 1,
        ...judgement,
        raw: content,
        inputTokens: usageToken(payload.usage?.prompt_tokens),
        outputTokens: usageToken(payload.usage?.completion_tokens),
        totalTokens: usageToken(payload.usage?.total_tokens),
      };
    },
  };
}

function createGoogleJudge(options: JudgeOptions): BenchmarkJudgeProvider {
  const model = options.model.trim();
  if (!model) throw new Error("LORE_BENCHMARK_JUDGE_MODEL is required");
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new Error("LORE_BENCHMARK_JUDGE_API_KEY or GEMINI_API_KEY is required for Google");
  }
  const url = endpoint(
    options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
    "interactions",
  );
  const timeoutMs = positiveInteger(options.timeoutMs, 43_200_000, 1, 43_200_000);
  const maximumOutputTokens = positiveInteger(options.maximumOutputTokens, 4_096, 32, 8_192);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    provider: "google",
    model,
    revision: LONGMEMEVAL_V2_JUDGE_REVISION,
    reasoningEffort: null,
    async judge(input) {
      const messages = buildLongMemEvalV2JudgeMessages({
        ...input,
        modelFinalAnswer: input.modelFinalAnswer ?? extractBoxedAnswer(input.modelFullResponse),
      });
      const response = await fetchImplementation(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          model,
          input: messages[1].content,
          system_instruction: messages[0].content,
          store: false,
          stream: false,
          generation_config: { max_output_tokens: maximumOutputTokens },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw await providerHttpError(
          response,
          `Google benchmark judge request failed with HTTP ${response.status}`,
        );
      }
      const payload = await readBoundedResponseJson<{
        status?: unknown;
        steps?: unknown;
        usage?: {
          total_input_tokens?: unknown;
          total_output_tokens?: unknown;
          total_tokens?: unknown;
        };
      }>(response);
      if (payload.status !== "completed" || !Array.isArray(payload.steps)) {
        throw new Error("Google benchmark judge returned an incomplete interaction");
      }
      let content: unknown;
      for (let index = payload.steps.length - 1; index >= 0; index -= 1) {
        const step = payload.steps[index];
        if (typeof step !== "object" || step === null || !("type" in step)) continue;
        if ((step as { type?: unknown }).type !== "model_output" || !("content" in step)) continue;
        const parts = (step as { content?: unknown }).content;
        if (!Array.isArray(parts)) continue;
        const textPart = parts.find(
          (part) =>
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            (part as { type?: unknown }).type === "text",
        );
        if (typeof textPart === "object" && textPart !== null && "text" in textPart) {
          content = (textPart as { text?: unknown }).text;
          break;
        }
      }
      if (typeof content !== "string") throw new Error("Google benchmark judge returned no text");
      const judgement = parseLongMemEvalV2JudgeResponse(content);
      return {
        correct: judgement.label === 1,
        ...judgement,
        raw: content,
        inputTokens: usageToken(payload.usage?.total_input_tokens),
        outputTokens: usageToken(payload.usage?.total_output_tokens),
        totalTokens: usageToken(payload.usage?.total_tokens),
      };
    },
  };
}

function configuredInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function createBenchmarkJudgeFromEnvironment(
  env: Record<string, string | undefined>,
): BenchmarkJudgeProvider | undefined {
  const provider = env.LORE_BENCHMARK_JUDGE_PROVIDER?.trim().toLowerCase();
  if (!provider) return undefined;
  if (provider !== "google" && provider !== "openai" && provider !== "vllm") {
    throw new Error(`Unsupported LORE_BENCHMARK_JUDGE_PROVIDER ${JSON.stringify(provider)}`);
  }
  const reasoning = env.LORE_BENCHMARK_JUDGE_REASONING_EFFORT?.trim().toLowerCase() || "medium";
  if (reasoning !== "low" && reasoning !== "medium" && reasoning !== "high") {
    throw new Error("LORE_BENCHMARK_JUDGE_REASONING_EFFORT must be low, medium, or high");
  }
  const common = {
    provider,
    model: env.LORE_BENCHMARK_JUDGE_MODEL ?? "",
    baseUrl: env.LORE_BENCHMARK_JUDGE_BASE_URL,
    apiKey:
      env.LORE_BENCHMARK_JUDGE_API_KEY ??
      (provider === "google" ? env.GEMINI_API_KEY : env.OPENAI_API_KEY),
    reasoningEffort: reasoning,
    timeoutMs: configuredInteger(env, "LORE_BENCHMARK_JUDGE_TIMEOUT_MS", 43_200_000),
    maximumOutputTokens: configuredInteger(env, "LORE_BENCHMARK_JUDGE_MAX_OUTPUT_TOKENS", 4_096),
  } satisfies JudgeOptions;
  return provider === "google" ? createGoogleJudge(common) : createOpenAICompatibleJudge(common);
}
