import { readFile } from "node:fs/promises";
import OpenAI from "openai";
import {
  type BenchmarkReaderProvider,
  createBenchmarkReaderFromEnvironment,
  renderBenchmarkReaderInput,
} from "../shared/benchmark-reader";
import { runCodexText } from "../shared/codex-exec";
import { datasetIsVerified, downloadDataset } from "../shared/dataset-download";
import { identityHash, sha256 } from "./hash";
import type { Dataset } from "./types";

/**
 * Pinned readers and judges. A profile's identity is part of every cache key, so
 * a changed model, instruction, or budget can never reuse an old answer or verdict.
 */
export const READER_PROFILES = {
  "gemini-3.5-flash": { provider: "google", model: "gemini-3.5-flash", maximumOutputTokens: 8192 },
} as const;
export type ReaderProfileName = keyof typeof READER_PROFILES;

export const JUDGE_PROFILES = {
  /** GPT-5.6-Sol through a logged-in Codex CLI; GPT-5.5 left ChatGPT Codex on 2026-10-14. */
  "gpt-5.6-sol": { transport: "codex-exec-chatgpt", model: "gpt-5.6-sol", reasoningEffort: "low" },
  /** The paper's judge model, through the Vercel AI Gateway (AI_GATEWAY_API_KEY). */
  "gpt-4o": {
    transport: "vercel-ai-gateway",
    model: "openai/gpt-4o",
    maximumOutputTokens: 16,
  },
} as const;
export type JudgeProfileName = keyof typeof JUDGE_PROFILES;

export function isReaderProfile(value: string | undefined): value is ReaderProfileName {
  return value !== undefined && Object.hasOwn(READER_PROFILES, value);
}
export function isJudgeProfile(value: string | undefined): value is JudgeProfileName {
  return value !== undefined && Object.hasOwn(JUDGE_PROFILES, value);
}

export interface BoundReader {
  identity: Record<string, unknown>;
  identityHash: string;
  /** The exact text the reader receives; its hash keys the answer cache. */
  render(question: string, evidence: Array<{ id: string; text: string }>): string;
  answer(
    question: string,
    evidence: Array<{ id: string; text: string }>,
  ): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }>;
}

/** A reader bound to one dataset's instruction and context budget. */
export function bindReader(
  name: ReaderProfileName,
  dataset: Dataset,
  apiKey: string | undefined,
): BoundReader {
  const profile = READER_PROFILES[name];
  const reader: BenchmarkReaderProvider | undefined = createBenchmarkReaderFromEnvironment({
    LORE_BENCHMARK_READER_PROVIDER: profile.provider,
    LORE_BENCHMARK_READER_MODEL: profile.model,
    LORE_BENCHMARK_READER_API_KEY: apiKey,
    LORE_BENCHMARK_READER_MAX_CONTEXT_CHARS: String(dataset.reader.maximumContextCharacters),
    LORE_BENCHMARK_READER_MAX_OUTPUT_TOKENS: String(profile.maximumOutputTokens),
  });
  if (!reader) throw new Error(`Reader profile ${name} could not be created`);
  const instruction = dataset.reader.instruction ?? reader.instruction;
  const identity = {
    profile: name,
    model: reader.model,
    transport: reader.transport,
    decoding: reader.decoding,
    readerRevision: reader.profile,
    instructionSha256: sha256(instruction),
    maximumContextCharacters: reader.maximumContextCharacters,
  };
  return {
    identity,
    identityHash: identityHash(identity),
    render: (question, evidence) =>
      `${instruction}\u0000${renderBenchmarkReaderInput(question, evidence, reader.maximumContextCharacters)}`,
    async answer(question, evidence) {
      const result = await reader.answer({
        question,
        evidence,
        ...(dataset.reader.instruction ? { systemInstruction: dataset.reader.instruction } : {}),
      });
      // The Google and gateway readers report no finish reason, so an empty or
      // truncated answer is caught by its text alone.
      if (!result.text.trim() || result.finishReason === "length") {
        throw new Error("Reader answer is empty or truncated");
      }
      return {
        text: result.text,
        inputTokens: result.inputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
      };
    },
  };
}

export interface BoundJudge {
  identity: Record<string, unknown>;
  identityHash: string;
  call(prompt: string): Promise<{
    text: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }>;
}

export function bindJudge(name: JudgeProfileName): BoundJudge {
  const profile = JUDGE_PROFILES[name];
  const identity = { profile: name, ...profile };
  if (profile.transport === "codex-exec-chatgpt") {
    return {
      identity,
      identityHash: identityHash(identity),
      call: (prompt) =>
        runCodexText({ model: profile.model, prompt, reasoningEffort: profile.reasoningEffort }),
    };
  }
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error(`Judge profile ${name} needs AI_GATEWAY_API_KEY`);
  const client = new OpenAI({
    apiKey,
    baseURL: "https://ai-gateway.vercel.sh/v1",
    maxRetries: 3,
    timeout: 120_000,
  });
  return {
    identity,
    identityHash: identityHash(identity),
    async call(prompt) {
      const response = await client.chat.completions.create({
        model: profile.model,
        temperature: 0,
        max_tokens: profile.maximumOutputTokens,
        messages: [{ role: "user", content: prompt }],
      });
      return {
        text: response.choices[0]?.message.content ?? "",
        inputTokens: response.usage?.prompt_tokens ?? null,
        outputTokens: response.usage?.completion_tokens ?? null,
      };
    },
  };
}

/** LongMemEval's official V1 rubric templates, pinned by the evaluate_qa.py digest. */
export const LONGMEMEVAL_RUBRIC = {
  path: "evaluation/datasets/longmemeval/evaluate_qa.d6dc8b50.py",
  upstreamCommit: "d6dc8b50a2d9ac0c99485ea28fa5755c62414c34",
  sha256: "ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251",
} as const;

/**
 * Where the pinned rubric comes from. Kept apart from LONGMEMEVAL_RUBRIC, which is
 * part of every verdict key: changing that object would discard every verdict.
 */
const LONGMEMEVAL_RUBRIC_SOURCE = {
  url: `https://raw.githubusercontent.com/xiaowu0162/LongMemEval/${LONGMEMEVAL_RUBRIC.upstreamCommit}/src/evaluation/evaluate_qa.py`,
  bytes: 7_436,
} as const;

/** The five V1 templates, downloading and verifying the pinned file on first use. */
export async function longMemEvalRubricTemplates(): Promise<string[]> {
  const pinned = { bytes: LONGMEMEVAL_RUBRIC_SOURCE.bytes, sha256: LONGMEMEVAL_RUBRIC.sha256 };
  if (!(await datasetIsVerified(LONGMEMEVAL_RUBRIC.path, pinned))) {
    await downloadDataset({
      url: LONGMEMEVAL_RUBRIC_SOURCE.url,
      outputPath: LONGMEMEVAL_RUBRIC.path,
      expected: pinned,
      label: "LongMemEval evaluate_qa.py",
    });
  }
  const source = await readFile(LONGMEMEVAL_RUBRIC.path, "utf8");
  if (sha256(source) !== LONGMEMEVAL_RUBRIC.sha256) {
    throw new Error(`${LONGMEMEVAL_RUBRIC.path} does not match the pinned rubric`);
  }
  const templates = [...source.matchAll(/template = "([^"\n]*)"/g)].map((match) =>
    (match[1] ?? "").replaceAll("\\n", "\n"),
  );
  if (templates.length !== 5) throw new Error("The pinned rubric no longer has five templates");
  return templates;
}
