// Benchmark-only write-time fact extraction for the LongMemEval e2e corpus.
//
// For every indexed session Memory in the benchmark corpus this builder asks
// an extractor model for a compact fact sheet and stores it as ONE new Memory
// in the same Workspace under the partition key `{questionId}#facts`, with the
// SAME benchmarkKey as its source session so answer-session scoring anchors
// are unchanged. Bob-private tripwires are replicated so the RLS hard gate
// stays in force. Embeddings drain through the ordinary leased maintenance
// path.
//
// This is an evaluator-side corpus profile in the spirit of mem0-style
// write-time extraction. It is NOT product consolidation: lore v1 explicitly
// excludes automatic summarization/merging, and nothing here touches the
// Memory interface (see AGENTS.md; the MemoryAgentBench structured-assembly
// profile is the in-repo precedent for benchmark-only evaluator paths).
//
// Usage:
//   BENCHMARK_DATABASE_URL=… LORE_EMBEDDING_PROVIDER=google \
//   LORE_EMBEDDING_MODEL=gemini-embedding-2 LORE_BENCHMARK_EMBEDDING_DIMENSIONS=1536 \
//   LORE_BENCHMARK_EXTRACTOR_MODEL=gemini-3.5-flash-lite \
//     bun scripts/benchmark-longmemeval-extract-facts.ts [--max-partitions N] [--concurrency 8]

import { createHash } from "node:crypto";
import {
  createMemoryMaintenanceModule,
  createMemoryModule,
  readBoundedResponseJson,
} from "@corespeed/lore-core";
import { createPostgresDatabase } from "@corespeed/lore-core/postgres";
import pg from "pg";
import { createEmbeddingProviderFromEnvironment } from "../src/lib/embedding/provider-factory";

const benchmarkNamePattern = /(^|_)bench(mark)?($|_)/i;
const aliceUserId = "00000000-0000-4000-8000-000000000101";
const bobUserId = "00000000-0000-4000-8000-000000000102";

export const FACTS_CORPUS_REVISION = "longmemeval-facts-v1";

const EXTRACTION_INSTRUCTION = `You distill one recorded conversation session into a compact fact sheet for a personal memory system.
Rules:
- Extract every distinct, self-contained fact that could answer a later question about the user, their life, plans, purchases, habits, preferences, or about what the assistant said or recommended in this session.
- Preserve exact names, numbers, quantities, products, places, and dates.
- The session header states the conversation date. Resolve relative time expressions (yesterday, last week, next month) into absolute dates using that session date, and keep the original phrasing in parentheses when you do.
- Attribute facts: prefix user facts with "User:" and assistant statements/recommendations with "Assistant:".
- One fact per line, as a dash list. No commentary, no summary sentences, no facts that are not present in the session.
- If the session contains nothing memorable, output exactly: - (no memorable facts)`;

interface CliOptions {
  maxPartitions?: number;
  concurrency: number;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { concurrency: 8 };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--max-partitions") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--max-partitions must be a positive integer");
      }
      options.maxPartitions = parsed;
      index += 1;
    } else if (flag === "--concurrency") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) {
        throw new Error("--concurrency must be an integer from 1 to 16");
      }
      options.concurrency = parsed;
      index += 1;
    } else {
      throw new Error(`Unknown extract-facts option ${flag}`);
    }
  }
  return options;
}

async function extractFacts(input: {
  model: string;
  apiKey: string;
  sessionContent: string;
}): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }> {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": input.apiKey },
    body: JSON.stringify({
      model: input.model,
      input: input.sessionContent,
      system_instruction: EXTRACTION_INSTRUCTION,
      store: false,
      stream: false,
      generation_config: { temperature: 0, max_output_tokens: 4_096 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`extractor failed with HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }
  const payload = (await readBoundedResponseJson(response, 4_000_000)) as {
    status?: unknown;
    steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    usage?: { total_input_tokens?: number; total_output_tokens?: number };
  };
  if (payload.status !== "completed" || !Array.isArray(payload.steps)) {
    throw new Error("extractor returned an incomplete interaction");
  }
  let text = "";
  for (let index = payload.steps.length - 1; index >= 0; index -= 1) {
    const step = payload.steps[index];
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    text = step.content
      .filter((item) => item?.type === "text")
      .map((item) => item.text ?? "")
      .join("")
      .trim();
    break;
  }
  if (!text) throw new Error("extractor returned no text");
  return {
    text,
    inputTokens: payload.usage?.total_input_tokens ?? null,
    outputTokens: payload.usage?.total_output_tokens ?? null,
  };
}

async function withRetries<T>(label: string, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        /HTTP (429|5\d\d)|timed? ?out|fetch failed|network|ECONNRESET|incomplete/i.test(message);
      if (!retryable || attempt === 4) break;
      const delaySeconds = Math.min(2 ** attempt * 5, 60);
      console.error(`${label} (attempt ${attempt}): ${message}; retrying in ${delaySeconds}s`);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, delaySeconds * 1_000));
    }
  }
  throw lastError;
}

const options = parseArgs(process.argv.slice(2));
const databaseUrl = process.env.BENCHMARK_DATABASE_URL;
if (!databaseUrl) throw new Error("BENCHMARK_DATABASE_URL is required");
const extractorModel = process.env.LORE_BENCHMARK_EXTRACTOR_MODEL ?? "gemini-3.5-flash-lite";
const extractorApiKey = process.env.GEMINI_API_KEY ?? "";
if (!extractorApiKey) throw new Error("GEMINI_API_KEY is required for the extractor");

function benchmarkEmbeddingDimensions(): number | undefined {
  const configured = process.env.LORE_BENCHMARK_EMBEDDING_DIMENSIONS;
  if (!configured?.trim()) return undefined;
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16_000) {
    throw new Error("LORE_BENCHMARK_EMBEDDING_DIMENSIONS must be an integer from 1 to 16000");
  }
  return parsed;
}

const overriddenDimensions = benchmarkEmbeddingDimensions();
const embeddingProvider = createEmbeddingProviderFromEnvironment(
  process.env,
  (message) => console.error(message),
  overriddenDimensions === undefined ? {} : { dimensions: overriddenDimensions },
);
if (!embeddingProvider) throw new Error("A valid Lore embedding provider is required");

const admin = new pg.Client({ connectionString: databaseUrl });
const requestDatabase = createPostgresDatabase({ connectionString: databaseUrl });
const maintenanceDatabase = createPostgresDatabase(
  { connectionString: databaseUrl },
  { role: "lore_maintenance" },
);
await admin.connect();

try {
  const databaseResult = await admin.query<{ name: string }>("SELECT current_database() AS name");
  const databaseName = databaseResult.rows[0]?.name ?? "";
  if (!benchmarkNamePattern.test(databaseName)) {
    throw new Error(
      `Refusing to run against non-benchmark database ${JSON.stringify(databaseName)}`,
    );
  }

  const partitionsResult = await admin.query<{ partition: string }>(
    `SELECT DISTINCT metadata->>'benchmarkPartition' AS partition
     FROM memories
     WHERE metadata->>'benchmarkPartition' IS NOT NULL
       AND metadata->>'benchmarkPartition' NOT LIKE '%#facts'
     ORDER BY partition`,
  );
  const partitions = partitionsResult.rows
    .map((row) => row.partition)
    .slice(0, options.maxPartitions ?? Number.POSITIVE_INFINITY);
  console.error(`Extracting facts for ${partitions.length} partitions with ${extractorModel}...`);

  const writeModule = createMemoryModule(requestDatabase, {
    embeddingDimensions: embeddingProvider.dimensions,
    embeddingProvider,
  });
  const tripwireWriteModule = createMemoryModule(requestDatabase);
  const instructionSha256 = createHash("sha256").update(EXTRACTION_INSTRUCTION).digest("hex");

  let extracted = 0;
  let skipped = 0;
  let fallbackCount = 0;
  let extractorInputTokens = 0;
  let extractorOutputTokens = 0;
  const startedAt = performance.now();

  for (const partition of partitions) {
    const factsPartition = `${partition}#facts`;
    const sourceResult = await admin.query<{
      workspace_id: string;
      owner_user_id: string;
      scope: string;
      content: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT workspace_id, owner_user_id, scope::text, content, metadata
       FROM memories
       WHERE metadata->>'benchmarkPartition' = $1
       ORDER BY id`,
      [partition],
    );
    if (sourceResult.rows.length === 0) continue;
    const existingResult = await admin.query<{ benchmark_key: string }>(
      `SELECT metadata->>'benchmarkKey' AS benchmark_key
       FROM memories
       WHERE metadata->>'benchmarkPartition' = $1`,
      [factsPartition],
    );
    const existingKeys = new Set(existingResult.rows.map((row) => row.benchmark_key));
    const pending = sourceResult.rows.filter(
      (row) => !existingKeys.has(String(row.metadata.benchmarkKey)),
    );
    skipped += sourceResult.rows.length - pending.length;

    let nextIndex = 0;
    async function worker(): Promise<void> {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        const row = pending[index];
        if (!row) return;
        const benchmarkKey = String(row.metadata.benchmarkKey);
        const workspaceId = row.workspace_id;
        const isTripwire = row.owner_user_id === bobUserId && row.scope === "private";
        const metadata = {
          ...row.metadata,
          benchmarkPartition: factsPartition,
          factsCorpus: FACTS_CORPUS_REVISION,
          extractorModel,
          extractorInstructionSha256: instructionSha256,
          sourcePartition: partition,
        };
        if (isTripwire) {
          await tripwireWriteModule.remember(
            { workspaceId, userId: bobUserId },
            { content: row.content, scope: "private", metadata },
          );
        } else {
          // A session the extractor cannot process (for example a provider
          // content-policy block on ShareGPT haystack text) passes through as
          // its original content so the facts corpus never silently drops
          // answerable evidence; the fallback is tagged for auditing.
          let content: string;
          let fallback: string | undefined;
          try {
            const facts = await withRetries(`extract ${partition}/${benchmarkKey}`, () =>
              extractFacts({
                model: extractorModel,
                apiKey: extractorApiKey,
                sessionContent: row.content,
              }),
            );
            extractorInputTokens += facts.inputTokens ?? 0;
            extractorOutputTokens += facts.outputTokens ?? 0;
            const sessionDate = String(row.metadata.sessionDate ?? "unknown date");
            content = [`Facts from conversation session at ${sessionDate}:`, facts.text]
              .join("\n")
              .slice(0, 31_000);
          } catch (error) {
            fallback = error instanceof Error ? error.message.slice(0, 200) : "unknown error";
            fallbackCount += 1;
            console.error(
              `Fallback to original content for ${partition}/${benchmarkKey}: ${fallback}`,
            );
            content = row.content.slice(0, 31_000);
          }
          await writeModule.remember(
            { workspaceId, userId: aliceUserId },
            {
              content,
              scope: "private",
              metadata:
                fallback === undefined
                  ? metadata
                  : {
                      ...metadata,
                      extractorFallback: "original-content",
                      extractorError: fallback,
                    },
            },
          );
        }
        extracted += 1;
        if (extracted % 200 === 0) {
          const rate = extracted / ((performance.now() - startedAt) / 60_000);
          console.error(
            `Extracted ${extracted.toLocaleString()} fact Memories (${rate.toFixed(0)}/min, skipped ${skipped})...`,
          );
        }
      }
    }
    await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
  }
  console.error(
    `Extraction complete: ${extracted} written (${fallbackCount} original-content fallbacks), ${skipped} already present, extractor tokens in/out ${extractorInputTokens}/${extractorOutputTokens}.`,
  );

  console.error("Draining embedding maintenance...");
  const maintenance = createMemoryMaintenanceModule(maintenanceDatabase, { embeddingProvider });
  let completedJobs = 0;
  let stalledRounds = 0;
  const sleep = (seconds: number) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, seconds * 1_000));
  for (;;) {
    const results = await Promise.all(Array.from({ length: 5 }, () => maintenance.run()));
    let roundCompleted = 0;
    let retryAfterSeconds = 0;
    for (const result of results) {
      if (result.status === "idle") continue;
      if (result.status === "dead") {
        throw new Error(`Embedding job ${result.jobId ?? "unknown"} ended as dead`);
      }
      if (result.status === "retry") {
        retryAfterSeconds = Math.max(
          retryAfterSeconds,
          Math.min(result.retryAfterSeconds ?? 30, 60),
        );
        continue;
      }
      completedJobs += 1;
      roundCompleted += 1;
    }
    if (roundCompleted > 0) {
      stalledRounds = 0;
      if (completedJobs % 1_000 < roundCompleted) {
        console.error(`Embedded ${completedJobs.toLocaleString()} fact Memories...`);
      }
      continue;
    }
    if (results.every((result) => result.status === "idle")) {
      const backlog = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM memory_embedding_jobs WHERE status = 'pending'",
      );
      if (Number(backlog.rows[0]?.count ?? 0) === 0) break;
      retryAfterSeconds = Math.max(retryAfterSeconds, 15);
    }
    stalledRounds += 1;
    if (stalledRounds > 40) {
      throw new Error("Embedding maintenance made no progress across 40 throttled rounds");
    }
    await sleep(Math.max(retryAfterSeconds, 15));
  }
  console.error(`Facts corpus ready: ${completedJobs} embedding jobs drained this run.`);
} finally {
  await admin.end().catch(() => undefined);
  await requestDatabase.close().catch(() => undefined);
  await maintenanceDatabase.close().catch(() => undefined);
}
