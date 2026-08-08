import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";
import {
  evaluateLongMemEvalV2Answer,
  isUnknownLongMemEvalV2Answer,
} from "../src/lib/answer-evaluation";
import { createPostgresDatabase } from "../src/lib/db/postgres";
import { createEmbeddingProviderFromEnvironment } from "../src/lib/embedding/provider-factory";
import { createMemoryMaintenanceModule } from "../src/lib/maintenance";
import {
  type ActorContext,
  createMemoryModule,
  RETRIEVAL_EVIDENCE_POLICY,
  RETRIEVAL_FEEDBACK_CANDIDATE_POLICY,
} from "../src/lib/memory";
import { createQueryPlanningProviderFromEnvironment } from "../src/lib/query-planning/provider-factory";
import { createRerankingProviderFromEnvironment } from "../src/lib/reranking/provider-factory";
import { createBenchmarkJudgeFromEnvironment } from "./lib/benchmark-judge";
import { createBenchmarkMetering } from "./lib/benchmark-metering";
import {
  type BenchmarkReaderImage,
  type BenchmarkReaderRuntimeSnapshot,
  createBenchmarkReaderFromEnvironment,
  LONGMEMEVAL_V2_READER_PROMPT_COMPATIBILITY,
  LONGMEMEVAL_V2_READER_PROMPT_SHA256,
  LONGMEMEVAL_V2_READER_PROTOCOL_REVISION,
  longMemEvalV2ReaderInstruction,
} from "./lib/benchmark-reader";
import { verifyFile } from "./lib/file-integrity";
import { requireExactIndexedMemory } from "./lib/indexed-memory-validation";
import {
  type LongMemEvalV2Question,
  longMemEvalV2ContainsLiteralAnswer,
  longMemEvalV2Manifest,
  longMemEvalV2QuestionScreenshot,
  mapLongMemEvalV2TrajectoryQuestions,
  readLongMemEvalV2Haystack,
  readLongMemEvalV2Questions,
  renderLongMemEvalV2Trajectory,
  selectLongMemEvalV2Questions,
  streamSelectedLongMemEvalV2Trajectories,
  validateLongMemEvalV2QuestionScreenshot,
} from "./lib/longmemeval-v2";
import { summarizeTokenUsage } from "./lib/token-usage";

type Tier = "small" | "medium";

interface CliOptions {
  tier: Tier;
  maxCases: number;
  limit: number;
  includeJudge: boolean;
  plan: boolean;
  retrievalOnly: boolean;
  reuseIndexed: boolean;
  outputPath?: string;
  questionTypes?: Set<string>;
}

const benchmarkNamePattern = /(^|_)bench(mark)?($|_)/i;
const aliceUserId = "00000000-0000-4000-8000-000000000201";
const bobUserId = "00000000-0000-4000-8000-000000000202";
const webWorkspaceId = "00000000-0000-4000-8000-000000000301";
const enterpriseWorkspaceId = "00000000-0000-4000-8000-000000000302";

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be positive`);
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    tier: "small",
    maxCases: 0,
    limit: 10,
    includeJudge: false,
    plan: false,
    retrievalOnly: false,
    reuseIndexed: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--tier") {
      if (value !== "small" && value !== "medium")
        throw new Error("--tier must be small or medium");
      options.tier = value;
      index += 1;
    } else if (flag === "--max-cases") {
      options.maxCases = positiveInteger(value, flag);
      index += 1;
    } else if (flag === "--limit") {
      options.limit = Math.min(100, positiveInteger(value, flag));
      index += 1;
    } else if (flag === "--question-types") {
      if (!value) throw new Error("--question-types requires comma-separated values");
      options.questionTypes = new Set(
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      );
      if (!options.questionTypes.size) throw new Error("--question-types selected no types");
      index += 1;
    } else if (flag === "--include-judge-cases") {
      options.includeJudge = true;
    } else if (flag === "--plan") {
      options.plan = true;
    } else if (flag === "--retrieval-only") {
      options.retrievalOnly = true;
    } else if (flag === "--reuse-indexed") {
      options.reuseIndexed = true;
    } else if (flag === "--output") {
      if (!value) throw new Error("--output requires a path");
      options.outputPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown LongMemEval-V2 option ${flag}`);
    }
  }
  return {
    ...options,
    maxCases: options.maxCases || (options.includeJudge ? 451 : 295),
  };
}

function workspaceId(domain: "web" | "enterprise"): string {
  return domain === "web" ? webWorkspaceId : enterpriseWorkspaceId;
}

function actor(domain: "web" | "enterprise", userId = aliceUserId): ActorContext {
  return { workspaceId: workspaceId(domain), userId };
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function mean(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function rounded(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tripwireContent(question: LongMemEvalV2Question): string {
  return `Private answer tripwire for ${question.id}\nQuestion: ${question.question}\nAnswer: ${question.answer}`;
}

function numericSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = numericSetting(name, fallback, minimum, maximum);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function corpusKey(
  tier: Tier,
  questions: LongMemEvalV2Question[],
  haystacks: ReadonlyMap<string, string[]>,
): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      revision: longMemEvalV2Manifest.revision,
      renderRevision: "lore-longmemeval-v2-trajectory-v1",
      trajectoriesSha256: longMemEvalV2Manifest.files.trajectories.sha256,
      tier,
      questions: questions.map((question) => ({
        id: question.id,
        domain: question.domain,
        evaluator: question.evaluator,
        haystack: haystacks.get(question.id),
      })),
    }),
  );
  return hash.digest("hex");
}

const options = parseArgs(process.argv.slice(2));
for (const domain of ["web", "enterprise"] as const) {
  if (
    sha256(longMemEvalV2ReaderInstruction(domain)) !== LONGMEMEVAL_V2_READER_PROMPT_SHA256[domain]
  ) {
    throw new Error(`LongMemEval-V2 ${domain} reader prompt does not match its pinned fingerprint`);
  }
}
const dataDirectory = resolve(
  process.env.LORE_LONGMEMEVAL_V2_DATA_DIR ?? "evaluation/datasets/longmemeval-v2",
);
const questionPath = resolve(dataDirectory, longMemEvalV2Manifest.files.questions.path);
const haystackFile = longMemEvalV2Manifest.files[options.tier];
const haystackPath = resolve(dataDirectory, haystackFile.path);
await verifyFile(questionPath, longMemEvalV2Manifest.files.questions);
await verifyFile(haystackPath, haystackFile);
const allQuestions = await readLongMemEvalV2Questions(questionPath);
const referencedQuestionImages = new Set(
  allQuestions.flatMap((question) => {
    const file = longMemEvalV2QuestionScreenshot(question.image);
    return file ? [file.path] : [];
  }),
);
if (
  referencedQuestionImages.size !== longMemEvalV2Manifest.questionScreenshots.length ||
  longMemEvalV2Manifest.questionScreenshots.some((file) => !referencedQuestionImages.has(file.path))
) {
  throw new Error("LongMemEval-V2 question screenshot manifest does not match the questions");
}
const selectedQuestions = selectLongMemEvalV2Questions(allQuestions, {
  maxCases: options.maxCases,
  deterministicOnly: !options.includeJudge,
  textOnly: false,
  questionTypes: options.questionTypes,
});
const haystacks = await readLongMemEvalV2Haystack(haystackPath);
const trajectoryQuestions = mapLongMemEvalV2TrajectoryQuestions(selectedQuestions, haystacks);
const questionById = new Map(selectedQuestions.map((question) => [question.id, question] as const));
const trajectoryDomains = new Map<string, "web" | "enterprise">();
for (const [trajectoryId, questionIds] of trajectoryQuestions) {
  const domains = new Set(
    [...questionIds].map((questionId) => {
      const question = questionById.get(questionId);
      if (!question) throw new Error(`Unknown selected question ${questionId}`);
      return question.domain;
    }),
  );
  if (domains.size !== 1) {
    throw new Error(`LongMemEval-V2 trajectory ${trajectoryId} crosses question domains`);
  }
  trajectoryDomains.set(trajectoryId, [...domains][0]);
}
const selectedCorpusKey = corpusKey(options.tier, selectedQuestions, haystacks);
const selection = {
  tier: options.tier,
  questionCount: selectedQuestions.length,
  trajectoryCount: trajectoryQuestions.size,
  questionTypes: Object.fromEntries(
    [...new Set(selectedQuestions.map((question) => question.questionType))]
      .sort()
      .map((type) => [
        type,
        selectedQuestions.filter((question) => question.questionType === type).length,
      ]),
  ),
  deterministicOnly: !options.includeJudge,
  textOnly: false,
  questionImageCount: selectedQuestions.filter((question) => question.image !== null).length,
  retrievalOnly: options.retrievalOnly,
  corpusKey: selectedCorpusKey,
};
if (options.plan) {
  console.log(JSON.stringify({ dataset: longMemEvalV2Manifest.name, selection }, null, 2));
  process.exit(0);
}
const questionImages = new Map<string, BenchmarkReaderImage>();
const questionImageAssets = new Map<
  string,
  {
    path: string;
    bytes: number;
    sha256: string;
    mimeType: "image/png";
    width: number;
    height: number;
  }
>();
for (const question of selectedQuestions) {
  const file = longMemEvalV2QuestionScreenshot(question.image);
  if (!file) continue;
  const imagePath = resolve(dataDirectory, file.path);
  await verifyFile(imagePath, file);
  const bytes = await readFile(imagePath);
  const dimensions = validateLongMemEvalV2QuestionScreenshot(bytes, file);
  questionImages.set(question.id, {
    data: bytes.toString("base64"),
    mimeType: file.mimeType,
  });
  questionImageAssets.set(question.id, { ...file, ...dimensions });
}
const trajectoryPath = resolve(dataDirectory, longMemEvalV2Manifest.files.trajectories.path);
await verifyFile(trajectoryPath, longMemEvalV2Manifest.files.trajectories);

const databaseUrl = process.env.BENCHMARK_DATABASE_URL;
if (!databaseUrl) throw new Error("BENCHMARK_DATABASE_URL is required unless --plan is used");
const reader = options.retrievalOnly
  ? undefined
  : createBenchmarkReaderFromEnvironment(process.env);
if (!options.retrievalOnly && !reader) {
  throw new Error("LORE_BENCHMARK_READER_PROVIDER is required unless --retrieval-only is used");
}
const readerRuntimeBefore: BenchmarkReaderRuntimeSnapshot | null =
  (await reader?.inspectRuntime?.()) ?? null;
if (questionImages.size > 0 && reader && !reader.supportsQuestionImages) {
  throw new Error("The configured LongMemEval-V2 reader does not support question images");
}
if (
  questionImages.size > 0 &&
  readerRuntimeBefore?.kind === "ollama-local" &&
  !readerRuntimeBefore.capabilities.includes("vision")
) {
  throw new Error("The configured local Ollama reader does not advertise the vision capability");
}
const judge =
  options.includeJudge && !options.retrievalOnly
    ? createBenchmarkJudgeFromEnvironment(process.env)
    : undefined;
const providerWarnings: string[] = [];
const configuredEmbeddingProvider = createEmbeddingProviderFromEnvironment(
  process.env,
  (message) => {
    providerWarnings.push(message);
    console.error(message);
  },
);
if (!configuredEmbeddingProvider)
  throw new Error("LongMemEval-V2 requires a valid embedding provider");
const configuredQueryPlanningProvider = createQueryPlanningProviderFromEnvironment(
  process.env,
  (message) => {
    providerWarnings.push(message);
    console.error(message);
  },
);
const configuredRerankingProvider = createRerankingProviderFromEnvironment(
  process.env,
  (message) => {
    providerWarnings.push(message);
    console.error(message);
  },
);
if (providerWarnings.length) throw new Error("LongMemEval-V2 provider configuration is invalid");
const metering = createBenchmarkMetering({
  embeddingProvider: configuredEmbeddingProvider,
  queryPlanningProvider: configuredQueryPlanningProvider,
  rerankingProvider: configuredRerankingProvider,
});
const { embeddingProvider, queryPlanningProvider, rerankingProvider } = metering;
const evidenceNeighborChunks = integerSetting("LORE_EVIDENCE_NEIGHBOR_CHUNKS", 0, 0, 2);
const evidenceTopChunks = integerSetting("LORE_EVIDENCE_TOP_CHUNKS", 1, 1, 5);
const retrievalFeedbackQueries = integerSetting("LORE_RETRIEVAL_FEEDBACK_QUERIES", 0, 0, 3);
const retrievalRecencyWeight = numericSetting("LORE_RETRIEVAL_RECENCY_WEIGHT", 0, 0, 1);
const queryPlannerMaxQueries = integerSetting("LORE_QUERY_PLANNER_MAX_QUERIES", 3, 1, 5);
const rerankCandidateLimit = integerSetting("LORE_RERANK_CANDIDATE_LIMIT", 50, 1, 200);
const rerankDiversityLambda = numericSetting("LORE_RERANK_DIVERSITY_LAMBDA", 1, 0, 1);
const rerankMinimumScore = numericSetting("LORE_RERANK_MIN_SCORE", 0, 0, 1);
const rerankWeight = numericSetting("LORE_RERANK_WEIGHT", 1, 0, 1);
const semanticDistanceThreshold = numericSetting("LORE_SEMANTIC_DISTANCE_THRESHOLD", 0.5, 0, 2);

const admin = new pg.Client({ connectionString: databaseUrl });
const requestDatabase = createPostgresDatabase({ connectionString: databaseUrl });
const maintenanceDatabase = createPostgresDatabase(
  { connectionString: databaseUrl },
  { role: "lore_maintenance" },
);
const startedAt = performance.now();
await admin.connect();
try {
  const databaseName = (await admin.query<{ name: string }>("SELECT current_database() AS name"))
    .rows[0]?.name;
  if (!databaseName || !benchmarkNamePattern.test(databaseName)) {
    throw new Error(`Refusing to modify non-benchmark database ${JSON.stringify(databaseName)}`);
  }
  const schema = await admin.query<{ memories: string | null; metadata_index: string | null }>(
    `SELECT
       to_regclass('public.memories')::text AS memories,
       to_regclass('public.memories_metadata_gin_idx')::text AS metadata_index`,
  );
  if (!schema.rows[0]?.memories || !schema.rows[0]?.metadata_index) {
    throw new Error("Lore migrations including 0004_memory_metadata_search.sql are required");
  }

  const trajectoryMemoryIds = new Map<string, string>();
  const tripwireMemoryIds = new Map<string, string>();
  const literalAnswerTrajectoryIds = new Map<string, Set<string>>();
  const recordLiteralAnswerAnchors = (trajectoryId: string, content: string) => {
    const questionIds = trajectoryQuestions.get(trajectoryId);
    if (!questionIds) throw new Error(`Unexpected selected trajectory ${trajectoryId}`);
    for (const questionId of questionIds) {
      const question = questionById.get(questionId);
      if (!question) throw new Error(`Unknown selected question ${questionId}`);
      if (!longMemEvalV2ContainsLiteralAnswer(content, question.answer)) continue;
      const anchors = literalAnswerTrajectoryIds.get(questionId) ?? new Set<string>();
      anchors.add(trajectoryId);
      literalAnswerTrajectoryIds.set(questionId, anchors);
    }
  };
  let indexingElapsedMs: number | null = null;
  let completedJobs: number | null = null;
  if (!options.reuseIndexed) {
    console.error(`Streaming ${trajectoryQuestions.size} selected trajectories...`);
    await admin.query("BEGIN");
    try {
      await admin.query("TRUNCATE users, workspaces CASCADE");
      await admin.query(
        `INSERT INTO users (id, display_name)
         VALUES ($1, 'V2 Alice'), ($2, 'V2 Bob')`,
        [aliceUserId, bobUserId],
      );
      await admin.query(
        `INSERT INTO workspaces (id, name)
         VALUES ($1, 'LongMemEval-V2 Web'), ($2, 'LongMemEval-V2 Enterprise')`,
        [webWorkspaceId, enterpriseWorkspaceId],
      );
      await admin.query(
        `INSERT INTO memberships (workspace_id, user_id, role)
         VALUES
           ($1, $3, 'owner'), ($1, $4, 'member'),
           ($2, $3, 'owner'), ($2, $4, 'member')`,
        [webWorkspaceId, enterpriseWorkspaceId, aliceUserId, bobUserId],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    const writer = createMemoryModule(requestDatabase, { embeddingProvider });
    const tripwireWriter = createMemoryModule(requestDatabase);
    let storedTrajectories = 0;
    for await (const trajectory of streamSelectedLongMemEvalV2Trajectories(
      trajectoryPath,
      new Set(trajectoryQuestions.keys()),
    )) {
      const trajectoryId = trajectory.id;
      const questionIds = trajectoryQuestions.get(trajectoryId);
      if (!questionIds) throw new Error(`Unexpected selected trajectory ${trajectoryId}`);
      if (trajectory.domain !== trajectoryDomains.get(trajectoryId)) {
        throw new Error(`Trajectory ${trajectoryId} does not match its question domain`);
      }
      const content = renderLongMemEvalV2Trajectory(trajectory);
      recordLiteralAnswerAnchors(trajectoryId, content);
      const memory = await writer.remember(actor(trajectory.domain), {
        content,
        scope: "private",
        metadata: {
          benchmark: longMemEvalV2Manifest.name,
          benchmarkVersion: longMemEvalV2Manifest.version,
          benchmarkRevision: longMemEvalV2Manifest.revision,
          corpusKey: selectedCorpusKey,
          domain: trajectory.domain,
          recordType: "trajectory",
          trajectoryId,
          questionIds: [...questionIds].sort(),
        },
      });
      trajectoryMemoryIds.set(trajectoryId, memory.id);
      storedTrajectories += 1;
      if (storedTrajectories % 25 === 0 || storedTrajectories === trajectoryQuestions.size) {
        console.error(`Stored ${storedTrajectories}/${trajectoryQuestions.size} trajectories...`);
      }
    }
    for (const question of selectedQuestions) {
      const memory = await tripwireWriter.remember(actor(question.domain, bobUserId), {
        content: tripwireContent(question),
        scope: "private",
        metadata: {
          benchmark: longMemEvalV2Manifest.name,
          benchmarkVersion: longMemEvalV2Manifest.version,
          benchmarkRevision: longMemEvalV2Manifest.revision,
          corpusKey: selectedCorpusKey,
          domain: question.domain,
          recordType: "tripwire",
          questionId: question.id,
          questionIds: [question.id],
        },
      });
      tripwireMemoryIds.set(question.id, memory.id);
    }
    const maintenance = createMemoryMaintenanceModule(maintenanceDatabase, { embeddingProvider });
    const indexingStartedAt = performance.now();
    completedJobs = 0;
    while (true) {
      const result = await maintenance.run();
      if (result.status === "idle") break;
      if (result.status !== "complete") {
        throw new Error(`Embedding job ${result.jobId ?? "unknown"} ended as ${result.status}`);
      }
      completedJobs += 1;
      if (completedJobs % 25 === 0) console.error(`Embedded ${completedJobs} Memories...`);
    }
    if (completedJobs !== trajectoryQuestions.size) {
      throw new Error(
        `Expected ${trajectoryQuestions.size} trajectory embedding jobs, completed ${completedJobs}`,
      );
    }
    indexingElapsedMs = performance.now() - indexingStartedAt;
  } else {
    const rows = await admin.query<{
      id: string;
      owner_user_id: string;
      scope: "shared" | "private";
      workspace_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT id, owner_user_id, scope, workspace_id, metadata
       FROM memories
       WHERE metadata @> $1::jsonb`,
      [JSON.stringify({ benchmark: longMemEvalV2Manifest.name, corpusKey: selectedCorpusKey })],
    );
    if (rows.rows.length !== trajectoryQuestions.size + selectedQuestions.length) {
      throw new Error("Indexed LongMemEval-V2 corpus does not match the exact selection");
    }
    for (const row of rows.rows) {
      if (
        row.metadata.recordType === "trajectory" &&
        typeof row.metadata.trajectoryId === "string"
      ) {
        const expectedQuestions = trajectoryQuestions.get(row.metadata.trajectoryId);
        const domain = row.metadata.domain;
        if (
          !expectedQuestions ||
          (domain !== "web" && domain !== "enterprise") ||
          domain !== trajectoryDomains.get(row.metadata.trajectoryId) ||
          row.owner_user_id !== aliceUserId ||
          row.workspace_id !== workspaceId(domain) ||
          row.scope !== "private" ||
          !Array.isArray(row.metadata.questionIds) ||
          JSON.stringify([...row.metadata.questionIds].sort()) !==
            JSON.stringify([...expectedQuestions].sort())
        ) {
          throw new Error(`Indexed trajectory ${row.metadata.trajectoryId} failed validation`);
        }
        trajectoryMemoryIds.set(row.metadata.trajectoryId, row.id);
      } else if (
        row.metadata.recordType === "tripwire" &&
        typeof row.metadata.questionId === "string"
      ) {
        const question = questionById.get(row.metadata.questionId);
        if (
          !question ||
          row.owner_user_id !== bobUserId ||
          row.workspace_id !== workspaceId(question.domain) ||
          row.scope !== "private" ||
          JSON.stringify(row.metadata.questionIds) !== JSON.stringify([question.id])
        ) {
          throw new Error(`Indexed tripwire ${row.metadata.questionId} failed validation`);
        }
        tripwireMemoryIds.set(row.metadata.questionId, row.id);
        await requireExactIndexedMemory({
          client: admin,
          memoryId: row.id,
          expectedContent: tripwireContent(question),
          embeddingProvider,
          label: `tripwire ${question.id}`,
          requireEmbedding: false,
        });
      } else {
        throw new Error("Indexed LongMemEval-V2 corpus contains an invalid record");
      }
    }
    if (
      trajectoryMemoryIds.size !== trajectoryQuestions.size ||
      tripwireMemoryIds.size !== selectedQuestions.length
    ) {
      throw new Error("Indexed LongMemEval-V2 corpus is incomplete");
    }
    let validatedTrajectories = 0;
    for await (const trajectory of streamSelectedLongMemEvalV2Trajectories(
      trajectoryPath,
      new Set(trajectoryQuestions.keys()),
    )) {
      const memoryId = trajectoryMemoryIds.get(trajectory.id);
      if (!memoryId) throw new Error(`Indexed trajectory ${trajectory.id} is missing`);
      const content = renderLongMemEvalV2Trajectory(trajectory);
      recordLiteralAnswerAnchors(trajectory.id, content);
      await requireExactIndexedMemory({
        client: admin,
        memoryId,
        expectedContent: content,
        embeddingProvider,
        label: `trajectory ${trajectory.id}`,
      });
      validatedTrajectories += 1;
      if (validatedTrajectories % 25 === 0 || validatedTrajectories === trajectoryQuestions.size) {
        console.error(
          `Validated ${validatedTrajectories}/${trajectoryQuestions.size} trajectory contents...`,
        );
      }
    }
  }

  const stale = await admin.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM memories memory
     WHERE memory.metadata @> $1::jsonb
       AND memory.metadata->>'recordType' <> 'tripwire'
       AND (
         NOT EXISTS (
           SELECT 1 FROM memory_chunks chunk
           WHERE chunk.workspace_id = memory.workspace_id AND chunk.memory_id = memory.id
         )
         OR EXISTS (
           SELECT 1 FROM memory_chunks chunk
           WHERE chunk.workspace_id = memory.workspace_id
             AND chunk.memory_id = memory.id
             AND (
               chunk.embedding IS NULL
               OR chunk.embedding_provider <> $2
               OR chunk.embedding_model <> $3
               OR chunk.embedding_revision <> $4
             )
         )
       )`,
    [
      JSON.stringify({ benchmark: longMemEvalV2Manifest.name, corpusKey: selectedCorpusKey }),
      embeddingProvider.provider,
      embeddingProvider.model,
      embeddingProvider.revision,
    ],
  );
  if (Number(stale.rows[0]?.count ?? 0) !== 0) {
    throw new Error("LongMemEval-V2 corpus contains stale or missing embeddings");
  }

  const searchModule = createMemoryModule(requestDatabase, {
    embeddingProvider,
    evidenceNeighborChunks,
    evidenceTopChunks,
    queryPlanningProvider,
    queryPlannerMaxQueries,
    retrievalFeedbackQueries,
    retrievalRecencyWeight,
    rerankingProvider,
    rerankCandidateLimit,
    rerankDiversityLambda,
    rerankMinimumScore,
    rerankWeight,
    semanticDistanceThreshold,
  });
  const results: Array<{
    questionId: string;
    questionType: string;
    correct: boolean | null;
    requiresJudge: boolean;
    judgeApplied: boolean;
    judgeLabel: 0 | 1 | null;
    judgeReason: string | null;
    prediction: string | null;
    modelResponse: string | null;
    reference: string;
    retrievedTrajectoryIds: string[];
    literalAnswerTrajectoryIds: string[];
    literalAnswerAnchorRank: number | null;
    searchLatencyMs: number;
    readerLatencyMs: number | null;
    judgeLatencyMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    readerFinishReason: string | null;
    readerNativeTimingNanoseconds: {
      total: number | null;
      load: number | null;
      promptEvaluation: number | null;
      evaluation: number | null;
    } | null;
    judgeInputTokens: number | null;
    judgeOutputTokens: number | null;
    judgeTotalTokens: number | null;
    questionImage: {
      path: string;
      bytes: number;
      sha256: string;
      mimeType: "image/png";
      width: number;
      height: number;
      sentToRetriever: false;
      sentToReader: boolean;
    } | null;
    isolationPassed: boolean;
  }> = [];
  const forbiddenMemoryIds = new Set(tripwireMemoryIds.values());
  for (const [index, question] of selectedQuestions.entries()) {
    const searchStartedAt = performance.now();
    const retrieved = await searchModule.search(actor(question.domain), {
      query: question.question,
      limit: options.limit,
      metadataFilter: {
        benchmark: longMemEvalV2Manifest.name,
        corpusKey: selectedCorpusKey,
        questionIds: [question.id],
      },
    });
    const searchLatencyMs = performance.now() - searchStartedAt;
    const isolationPassed = !retrieved.some((result) => forbiddenMemoryIds.has(result.memory.id));
    const retrievedTrajectoryIds = retrieved
      .map((result) => result.memory.metadata.trajectoryId)
      .filter((value): value is string => typeof value === "string");
    const literalAnchors = literalAnswerTrajectoryIds.get(question.id) ?? new Set<string>();
    const anchorIndex = retrievedTrajectoryIds.findIndex((id) => literalAnchors.has(id));
    let correct: boolean | null = null;
    let requiresJudge = question.evaluator.startsWith("llm_");
    let judgeApplied = false;
    let judgeLabel: 0 | 1 | null = null;
    let judgeReason: string | null = null;
    let judgeLatencyMs: number | null = null;
    let judgeInputTokens: number | null = null;
    let judgeOutputTokens: number | null = null;
    let judgeTotalTokens: number | null = null;
    let prediction: string | null = null;
    let modelResponse: string | null = null;
    let reference = question.answer;
    let readerLatencyMs: number | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let totalTokens: number | null = null;
    let readerFinishReason: string | null = null;
    let readerNativeTimingNanoseconds: {
      total: number | null;
      load: number | null;
      promptEvaluation: number | null;
      evaluation: number | null;
    } | null = null;
    if (reader) {
      const readerStartedAt = performance.now();
      const answer = await reader.answer({
        question: question.question,
        questionImage: questionImages.get(question.id),
        systemInstruction: longMemEvalV2ReaderInstruction(question.domain),
        promptStyle: "longmemeval-v2",
        evidence: retrieved.map((result) => ({
          id:
            typeof result.memory.metadata.trajectoryId === "string"
              ? result.memory.metadata.trajectoryId
              : result.memory.id,
          text: result.evidence,
        })),
      });
      readerLatencyMs = performance.now() - readerStartedAt;
      const evaluation = evaluateLongMemEvalV2Answer({
        prediction: answer.text,
        reference: question.answer,
        evaluator: question.evaluator,
      });
      correct = evaluation.correct;
      requiresJudge = evaluation.requiresJudge;
      prediction = evaluation.prediction;
      modelResponse = answer.text;
      reference = evaluation.reference;
      inputTokens = answer.inputTokens;
      outputTokens = answer.outputTokens;
      totalTokens = answer.totalTokens;
      readerFinishReason = answer.finishReason ?? null;
      readerNativeTimingNanoseconds = answer.nativeTimingNanoseconds ?? null;
      if (evaluation.requiresJudge && judge && evaluation.judgeKind) {
        const judgeStartedAt = performance.now();
        const judgement = await judge.judge({
          kind: evaluation.judgeKind,
          question: question.question,
          referenceAnswer: question.answer,
          modelFullResponse: answer.text,
          modelFinalAnswer: evaluation.prediction,
        });
        judgeLatencyMs = rounded(performance.now() - judgeStartedAt, 2);
        judgeApplied = true;
        judgeLabel = judgement.label;
        judgeReason = judgement.reason;
        judgeInputTokens = judgement.inputTokens;
        judgeOutputTokens = judgement.outputTokens;
        judgeTotalTokens = judgement.totalTokens;
        correct = judgement.correct;
      }
      // The official harness makes an exact UNKNOWN answer incorrect after every evaluator.
      if (correct !== null && isUnknownLongMemEvalV2Answer(answer.text)) correct = false;
    }
    const questionImageAsset = questionImageAssets.get(question.id);
    results.push({
      questionId: question.id,
      questionType: question.questionType,
      correct,
      requiresJudge,
      judgeApplied,
      judgeLabel,
      judgeReason,
      prediction,
      modelResponse,
      reference,
      retrievedTrajectoryIds,
      literalAnswerTrajectoryIds: [...literalAnchors].sort(),
      literalAnswerAnchorRank: anchorIndex < 0 ? null : anchorIndex + 1,
      searchLatencyMs: rounded(searchLatencyMs, 2),
      readerLatencyMs: readerLatencyMs === null ? null : rounded(readerLatencyMs, 2),
      judgeLatencyMs,
      inputTokens,
      outputTokens,
      totalTokens,
      readerFinishReason,
      readerNativeTimingNanoseconds,
      judgeInputTokens,
      judgeOutputTokens,
      judgeTotalTokens,
      questionImage: questionImageAsset
        ? {
            ...questionImageAsset,
            sentToRetriever: false,
            sentToReader: Boolean(reader),
          }
        : null,
      isolationPassed,
    });
    console.error(
      `Evaluated ${index + 1}/${selectedQuestions.length}: ${question.id} (${correct ?? (reader ? "judge-unresolved" : "retrieval-only")})`,
    );
  }

  const scored = results.filter(
    (result): result is typeof result & { correct: boolean } => result.correct !== null,
  );
  const categoryMetrics = Object.fromEntries(
    [...new Set(results.map((result) => result.questionType))].sort().map((questionType) => {
      const category = results.filter((result) => result.questionType === questionType);
      const scoredCategory = category.filter(
        (result): result is typeof result & { correct: boolean } => result.correct !== null,
      );
      const literalAnchorCategory = category.filter(
        (result) => result.literalAnswerTrajectoryIds.length > 0,
      );
      return [
        questionType,
        {
          caseCount: category.length,
          scoredCount: scoredCategory.length,
          unresolvedJudgeCount: category.length - scoredCategory.length,
          accuracy: scoredCategory.length
            ? rounded(
                scoredCategory.filter((result) => result.correct).length / scoredCategory.length,
              )
            : null,
          literalAnswerAnchorCaseCount: literalAnchorCategory.length,
          literalAnswerAnchorRecallAtOne: literalAnchorCategory.length
            ? rounded(
                literalAnchorCategory.filter((result) => result.literalAnswerAnchorRank === 1)
                  .length / literalAnchorCategory.length,
              )
            : null,
          literalAnswerAnchorRecallAtK: literalAnchorCategory.length
            ? rounded(
                literalAnchorCategory.filter((result) => result.literalAnswerAnchorRank !== null)
                  .length / literalAnchorCategory.length,
              )
            : null,
        },
      ];
    }),
  );
  const hardFailureCount = results.filter((result) => !result.isolationPassed).length;
  const searchLatencies = results.map((result) => result.searchLatencyMs);
  const readerLatencies = results
    .map((result) => result.readerLatencyMs)
    .filter((value): value is number => value !== null);
  const literalAnchorCases = results.filter(
    (result) => result.literalAnswerTrajectoryIds.length > 0,
  );
  const scoredWithLiteralAnchor = scored.filter(
    (result) => result.literalAnswerAnchorRank !== null,
  );
  const judgeLatencies = results
    .map((result) => result.judgeLatencyMs)
    .filter((value): value is number => value !== null);
  const readerTokenUsage = summarizeTokenUsage(results);
  const readerRuntimeAfter: BenchmarkReaderRuntimeSnapshot | null =
    (await reader?.inspectRuntime?.()) ?? null;
  if (JSON.stringify(readerRuntimeBefore) !== JSON.stringify(readerRuntimeAfter)) {
    throw new Error("Benchmark reader runtime or model identity changed during the run");
  }
  const judgeTokenUsage = summarizeTokenUsage(
    results
      .filter((result) => result.judgeApplied)
      .map((result) => ({
        inputTokens: result.judgeInputTokens,
        outputTokens: result.judgeOutputTokens,
        totalTokens: result.judgeTotalTokens,
      })),
  );
  const report = {
    dataset: {
      name: longMemEvalV2Manifest.name,
      version: longMemEvalV2Manifest.version,
      revision: longMemEvalV2Manifest.revision,
      source: longMemEvalV2Manifest.source,
      license: longMemEvalV2Manifest.license,
    },
    selection,
    database: databaseName,
    embeddingSpace: {
      provider: embeddingProvider.provider,
      model: embeddingProvider.model,
      dimensions: embeddingProvider.dimensions,
      revision: embeddingProvider.revision,
    },
    queryPlanning: queryPlanningProvider
      ? {
          provider: queryPlanningProvider.provider,
          model: queryPlanningProvider.model,
          revision: queryPlanningProvider.revision ?? null,
          instruction: queryPlanningProvider.instruction ?? null,
          maximumQueries: queryPlannerMaxQueries,
        }
      : null,
    reranking: rerankingProvider
      ? {
          provider: rerankingProvider.provider,
          model: rerankingProvider.model,
          revision: rerankingProvider.revision ?? null,
          instruction: rerankingProvider.instruction ?? null,
          candidateLimit: rerankCandidateLimit,
          minimumScore: rerankMinimumScore,
          diversityLambda: rerankDiversityLambda,
          weight: rerankWeight,
        }
      : null,
    retrieval: {
      limit: options.limit,
      semanticDistanceThreshold,
      evidenceNeighborChunks,
      evidenceTopChunks,
      evidencePolicy: RETRIEVAL_EVIDENCE_POLICY,
      feedbackQueries: retrievalFeedbackQueries,
      feedbackCandidatePolicy:
        retrievalFeedbackQueries > 0 ? RETRIEVAL_FEEDBACK_CANDIDATE_POLICY : null,
      recencyWeight: retrievalRecencyWeight,
      secondStageCandidateLimit:
        rerankingProvider || retrievalRecencyWeight > 0 ? rerankCandidateLimit : null,
      questionImageSentToRetriever: false,
      trajectoryImagesIndexed: false,
    },
    reader: reader
      ? {
          provider: reader.provider,
          model: reader.model,
          revision: reader.revision,
          profile: reader.profile,
          transport: reader.transport,
          keepAlive: reader.keepAlive ?? null,
          instruction: reader.instruction,
          systemInstructions: {
            web: {
              text: longMemEvalV2ReaderInstruction("web"),
              sha256: sha256(longMemEvalV2ReaderInstruction("web")),
            },
            enterprise: {
              text: longMemEvalV2ReaderInstruction("enterprise"),
              sha256: sha256(longMemEvalV2ReaderInstruction("enterprise")),
            },
          },
          promptCompatibility: LONGMEMEVAL_V2_READER_PROMPT_COMPATIBILITY,
          expectedPromptSha256: LONGMEMEVAL_V2_READER_PROMPT_SHA256,
          maximumContextCharacters: reader.maximumContextCharacters,
          contextBudgetUnit: "characters",
          decoding: reader.decoding,
          runtimeBefore: readerRuntimeBefore,
          runtimeAfter: readerRuntimeAfter,
          supportsQuestionImages: reader.supportsQuestionImages,
          questionImageCount: questionImages.size,
          questionImageSentToReader: questionImages.size > 0,
          imageDetail: "provider-default",
          protocolRevision: LONGMEMEVAL_V2_READER_PROTOCOL_REVISION,
        }
      : null,
    judge: judge
      ? {
          provider: judge.provider,
          model: judge.model,
          revision: judge.revision,
          reasoningEffort: judge.reasoningEffort,
        }
      : null,
    indexing: {
      reused: options.reuseIndexed,
      completedJobs,
      elapsedMs: indexingElapsedMs === null ? null : rounded(indexingElapsedMs, 2),
    },
    workload: metering.workload,
    metrics: {
      caseCount: results.length,
      scoredCount: scored.length,
      unresolvedJudgeCount: results.length - scored.length,
      accuracy: scored.length
        ? rounded(scored.filter((result) => result.correct).length / scored.length)
        : null,
      accuracyGivenLiteralAnswerAnchor: scoredWithLiteralAnchor.length
        ? rounded(
            scoredWithLiteralAnchor.filter((result) => result.correct).length /
              scoredWithLiteralAnchor.length,
          )
        : null,
      readerFailureWithLiteralAnswerAnchorCount: scoredWithLiteralAnchor.filter(
        (result) => !result.correct,
      ).length,
      literalAnswerAnchorCaseCount: literalAnchorCases.length,
      literalAnswerAnchorRecallAtOne: literalAnchorCases.length
        ? rounded(
            literalAnchorCases.filter((result) => result.literalAnswerAnchorRank === 1).length /
              literalAnchorCases.length,
          )
        : null,
      literalAnswerAnchorRecallAtK: literalAnchorCases.length
        ? rounded(
            literalAnchorCases.filter((result) => result.literalAnswerAnchorRank !== null).length /
              literalAnchorCases.length,
          )
        : null,
      literalAnswerAnchorMrr: literalAnchorCases.length
        ? rounded(
            mean(
              literalAnchorCases.map((result) =>
                result.literalAnswerAnchorRank === null ? 0 : 1 / result.literalAnswerAnchorRank,
              ),
            ),
          )
        : null,
      isolationPassed: hardFailureCount === 0,
      hardFailureCount,
      averageSearchLatencyMs: rounded(mean(searchLatencies), 2),
      p95SearchLatencyMs: rounded(percentile(searchLatencies, 0.95), 2),
      averageReaderLatencyMs: readerLatencies.length ? rounded(mean(readerLatencies), 2) : null,
      p95ReaderLatencyMs: readerLatencies.length
        ? rounded(percentile(readerLatencies, 0.95), 2)
        : null,
      averageJudgeLatencyMs: judgeLatencies.length ? rounded(mean(judgeLatencies), 2) : null,
      p95JudgeLatencyMs: judgeLatencies.length
        ? rounded(percentile(judgeLatencies, 0.95), 2)
        : null,
      totalInputTokens: readerTokenUsage.input.total,
      totalOutputTokens: readerTokenUsage.output.total,
      totalTokens: readerTokenUsage.total.total,
      totalJudgeInputTokens: judgeTokenUsage.input.total,
      totalJudgeOutputTokens: judgeTokenUsage.output.total,
      totalJudgeTokens: judgeTokenUsage.total.total,
      readerTokenUsage,
      judgeTokenUsage,
    },
    metricsByCategory: categoryMetrics,
    cases: results,
    valid: hardFailureCount === 0 && providerWarnings.length === 0,
    scoreComplete: scored.length === results.length,
    elapsedMs: rounded(performance.now() - startedAt, 2),
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, "utf8");
    console.error(`Wrote LongMemEval-V2 report to ${outputPath}`);
    console.log(JSON.stringify({ metrics: report.metrics, valid: report.valid }, null, 2));
  } else {
    console.log(serialized.trimEnd());
  }
  if (!report.valid) process.exitCode = 1;
} finally {
  await Promise.all([
    requestDatabase.close(),
    maintenanceDatabase.close(),
    ...(reader?.close ? [reader.close()] : []),
  ]);
  await admin.end();
}
