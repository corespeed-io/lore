import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { createPostgresDatabase } from "../src/lib/db/postgres";
import { createEmbeddingProviderFromEnvironment } from "../src/lib/embedding/provider-factory";
import {
  type ActorContext,
  type ContextGroupExpansionOptions,
  createMemoryModule,
  RETRIEVAL_CONTEXT_GROUP_POLICY,
  RETRIEVAL_EVIDENCE_POLICY,
  RETRIEVAL_FEEDBACK_CANDIDATE_POLICY,
} from "../src/lib/memory";
import { createQueryPlanningProviderFromEnvironment } from "../src/lib/query-planning/provider-factory";
import { createRerankingProviderFromEnvironment } from "../src/lib/reranking/provider-factory";
import { createBenchmarkMetering } from "./lib/benchmark-metering";
import {
  type BenchmarkReaderRuntimeSnapshot,
  createBenchmarkReaderFromEnvironment,
} from "./lib/benchmark-reader";
import { verifyFile } from "./lib/file-integrity";
import { requireExactIndexedMemory } from "./lib/indexed-memory-validation";
import {
  evaluateLocomoAnswer,
  LOCOMO_CATEGORIES,
  LOCOMO_CATEGORY_NAMES,
  LOCOMO_POSITIVE_CATEGORIES,
  LOCOMO_POSITIVE_QA_PROTOCOL,
  LOCOMO_READER_INSTRUCTION,
  LOCOMO_SCORER_REVISION,
  type LocomoCategory,
  type LocomoQuestion,
  type LocomoSelectedSample,
  locomoManifest,
  locomoReaderQuestion,
  readLocomoPartitions,
  readSelectedLocomoSamples,
  toLocomoPartition,
} from "./lib/locomo";
import { runRetrievalBenchmarkSuite } from "./lib/run-retrieval-suite";
import { summarizeTokenUsage } from "./lib/token-usage";

interface CliOptions {
  casesPerCategory?: number;
  categories: Set<LocomoCategory>;
  datasetPath?: string;
  limit: number;
  maxCases?: number;
  outputPath?: string;
  reuseIndexed: boolean;
  sampleIds?: Set<string>;
  skipRetrievalDiagnostic: boolean;
}

interface PersistedMemory {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  metadata: Record<string, unknown>;
}

const aliceUserId = "00000000-0000-4000-8000-000000000101";
const bobUserId = "00000000-0000-4000-8000-000000000102";
const benchmarkNamePattern = /(^|_)bench(mark)?($|_)/i;

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be positive`);
  return parsed;
}

function parseCategory(value: string, flag: string): LocomoCategory {
  const parsed = Number(value);
  if (!LOCOMO_CATEGORIES.includes(parsed as LocomoCategory)) {
    throw new Error(`${flag} values must be LoCoMo categories from 1 to 5`);
  }
  return parsed as LocomoCategory;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    categories: new Set(LOCOMO_POSITIVE_CATEGORIES),
    limit: 10,
    reuseIndexed: false,
    skipRetrievalDiagnostic: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--dataset") {
      if (!value) throw new Error("--dataset requires a path");
      options.datasetPath = value;
      index += 1;
    } else if (flag === "--max-cases") {
      options.maxCases = positiveInteger(value, flag);
      index += 1;
    } else if (flag === "--cases-per-category") {
      options.casesPerCategory = positiveInteger(value, flag);
      index += 1;
    } else if (flag === "--categories") {
      if (!value) throw new Error("--categories requires comma-separated category numbers");
      options.categories = new Set(
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => parseCategory(item, flag)),
      );
      if (!options.categories.size) throw new Error("--categories selected no categories");
      index += 1;
    } else if (flag === "--limit") {
      options.limit = Math.min(100, positiveInteger(value, flag));
      index += 1;
    } else if (flag === "--sample-ids") {
      if (!value) throw new Error("--sample-ids requires comma-separated sample ids");
      options.sampleIds = new Set(
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      );
      if (!options.sampleIds.size) throw new Error("--sample-ids selected no samples");
      index += 1;
    } else if (flag === "--output") {
      if (!value) throw new Error("--output requires a path");
      options.outputPath = value;
      index += 1;
    } else if (flag === "--reuse-indexed") {
      options.reuseIndexed = true;
    } else if (flag === "--skip-retrieval-diagnostic") {
      options.skipRetrievalDiagnostic = true;
    } else {
      throw new Error(`Unknown LoCoMo option ${flag}`);
    }
  }
  if (options.categories.has(5)) {
    throw new Error(
      "LoCoMo category 5 is not a valid standalone quality benchmark: every released item has the same unanswerable label; run categories 1-4",
    );
  }
  return options;
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

function rounded(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function mean(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function questionId(selection: LocomoSelectedSample, question: LocomoQuestion): string {
  return `${selection.sample.id}/${question.key}`;
}

const options = parseArgs(process.argv.slice(2));
const databaseUrl = process.env.BENCHMARK_DATABASE_URL;
if (!databaseUrl) throw new Error("BENCHMARK_DATABASE_URL is required");
const manifestFile = locomoManifest.files.dataset;
const datasetPath = resolve(
  options.datasetPath ??
    process.env.LORE_LOCOMO_DATASET ??
    `evaluation/datasets/locomo/${manifestFile.filename}`,
);
await verifyFile(datasetPath, manifestFile);

const selections: LocomoSelectedSample[] = [];
for await (const selection of readSelectedLocomoSamples(datasetPath, options)) {
  selections.push(selection);
}
const selectedQuestions = selections.flatMap((selection) =>
  selection.questions.map((question) => ({ selection, question })),
);
const profile = LOCOMO_POSITIVE_QA_PROTOCOL;
const caseOrderSha256 = sha256(
  JSON.stringify(
    selectedQuestions.map(({ selection, question }) => questionId(selection, question)),
  ),
);

const providerWarnings: string[] = [];
const configuredEmbeddingProvider = createEmbeddingProviderFromEnvironment(
  process.env,
  (message) => {
    providerWarnings.push(message);
    console.error(message);
  },
);
if (!configuredEmbeddingProvider) throw new Error("LoCoMo requires an embedding provider");
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
if (providerWarnings.length) throw new Error("LoCoMo provider configuration is invalid");
const reader = createBenchmarkReaderFromEnvironment(process.env);
if (!reader) throw new Error("LORE_BENCHMARK_READER_PROVIDER is required");
const readerRuntimeBefore: BenchmarkReaderRuntimeSnapshot | null =
  (await reader.inspectRuntime?.()) ?? null;

const queryPlannerMaxQueries = integerSetting("LORE_QUERY_PLANNER_MAX_QUERIES", 3, 1, 5);
const rerankCandidateLimit = integerSetting("LORE_RERANK_CANDIDATE_LIMIT", 50, 1, 200);
const rerankDiversityLambda = numericSetting("LORE_RERANK_DIVERSITY_LAMBDA", 1, 0, 1);
const rerankMinimumScore = numericSetting("LORE_RERANK_MIN_SCORE", 0, 0, 1);
const rerankWeight = numericSetting("LORE_RERANK_WEIGHT", 1, 0, 1);
const retrievalFeedbackQueries = integerSetting("LORE_RETRIEVAL_FEEDBACK_QUERIES", 0, 0, 3);
const retrievalRecencyWeight = numericSetting("LORE_RETRIEVAL_RECENCY_WEIGHT", 0, 0, 1);
const evidenceNeighborChunks = integerSetting("LORE_EVIDENCE_NEIGHBOR_CHUNKS", 0, 0, 2);
const evidenceTopChunks = integerSetting("LORE_EVIDENCE_TOP_CHUNKS", 1, 1, 5);
const semanticDistanceThreshold = numericSetting("LORE_SEMANTIC_DISTANCE_THRESHOLD", 0.5, 0, 2);
const contextGroupMetadataKey = process.env.LORE_BENCHMARK_CONTEXT_GROUP_KEY?.trim() || undefined;
const contextGroupOrdinalMetadataKey =
  process.env.LORE_BENCHMARK_CONTEXT_GROUP_ORDINAL_KEY?.trim() || undefined;
const contextGroupExpansion: ContextGroupExpansionOptions | undefined = contextGroupMetadataKey
  ? {
      groupMetadataKey: contextGroupMetadataKey,
      ...(contextGroupOrdinalMetadataKey
        ? { ordinalMetadataKey: contextGroupOrdinalMetadataKey }
        : {}),
      baseCandidateLimit: integerSetting("LORE_BENCHMARK_CONTEXT_GROUP_BASE_LIMIT", 20, 1, 200),
      maximumGroups: integerSetting("LORE_BENCHMARK_CONTEXT_GROUP_MAX_GROUPS", 3, 1, 20),
    }
  : undefined;

const retrievalOutputPath =
  !options.skipRetrievalDiagnostic && options.outputPath
    ? options.outputPath.replace(/\.json$/i, ".retrieval.json")
    : undefined;
const retrievalReport = options.skipRetrievalDiagnostic
  ? null
  : await runRetrievalBenchmarkSuite({
      databaseUrl,
      embeddingProvider: configuredEmbeddingProvider,
      contextGroupExpansion,
      queryPlanningProvider: configuredQueryPlanningProvider,
      queryPlannerMaxQueries,
      retrievalFeedbackQueries,
      retrievalRecencyWeight,
      rerankingProvider: configuredRerankingProvider,
      rerankCandidateLimit,
      rerankDiversityLambda,
      rerankMinimumScore,
      rerankWeight,
      providerWarnings,
      outputPath: retrievalOutputPath,
      printReport: false,
      reuseIndexed: options.reuseIndexed,
      suite: {
        name: `${locomoManifest.name} ${profile}`,
        version: locomoManifest.version,
        description: "LoCoMo QA evidence retrieval preceding the pinned Lore reader/scorer path.",
        thresholds: [semanticDistanceThreshold],
        provenance: {
          source: locomoManifest.source,
          paper: locomoManifest.paper,
          revision: locomoManifest.revision,
          sha256: manifestFile.sha256,
          license: locomoManifest.license,
          profile,
          caseOrderSha256,
          retrievalLimit: options.limit,
        },
        partitions: readLocomoPartitions(datasetPath, options),
      },
    });

const metering = createBenchmarkMetering({
  embeddingProvider: configuredEmbeddingProvider,
  queryPlanningProvider: configuredQueryPlanningProvider,
  rerankingProvider: configuredRerankingProvider,
});
const { embeddingProvider, queryPlanningProvider, rerankingProvider } = metering;
const requestDatabase = createPostgresDatabase({ connectionString: databaseUrl });
const admin = new pg.Client({ connectionString: databaseUrl });
const startedAt = performance.now();
await admin.connect();
try {
  const databaseName = (await admin.query<{ name: string }>("SELECT current_database() AS name"))
    .rows[0]?.name;
  if (!databaseName || !benchmarkNamePattern.test(databaseName)) {
    throw new Error(`Refusing to read non-benchmark database ${JSON.stringify(databaseName)}`);
  }
  const searchModule = createMemoryModule(requestDatabase, {
    contextGroupExpansion,
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
    caseId: string;
    sampleId: string;
    questionKey: string;
    category: LocomoCategory;
    categoryName: string;
    question: string;
    reference: string | number | null;
    rawPrediction: string;
    prediction: string;
    score: number;
    retrievedDialogIds: string[];
    annotatedEvidenceIds: string[];
    unresolvedEvidenceIds: string[];
    evidenceRecallAtOne: number | null;
    evidenceRecallAtK: number | null;
    evidenceReciprocalRank: number | null;
    searchLatencyMs: number;
    readerLatencyMs: number;
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
    isolationPassed: boolean;
  }> = [];

  for (const selection of selections) {
    const rows = await admin.query<PersistedMemory>(
      `SELECT id, workspace_id, owner_user_id, metadata
       FROM memories
       WHERE metadata->>'benchmarkPartition' = $1
       ORDER BY id`,
      [selection.sample.id],
    );
    const workspaceIds = new Set(rows.rows.map((row) => row.workspace_id));
    if (workspaceIds.size !== 1) {
      throw new Error(`Indexed LoCoMo sample ${selection.sample.id} must use one Workspace`);
    }
    const workspaceId = [...workspaceIds][0];
    const actor: ActorContext = { workspaceId, userId: aliceUserId };
    const dialogRows = new Map<string, PersistedMemory>();
    const tripwireRows = new Map<string, PersistedMemory>();
    for (const row of rows.rows) {
      if (row.metadata.recordType === "dialog" && typeof row.metadata.dialogId === "string") {
        if (row.owner_user_id !== aliceUserId) {
          throw new Error(`LoCoMo dialog ${row.metadata.dialogId} has the wrong owner`);
        }
        dialogRows.set(row.metadata.dialogId, row);
      } else if (row.metadata.recordType === "tripwire") {
        if (row.owner_user_id !== bobUserId) {
          throw new Error(`LoCoMo tripwire in ${selection.sample.id} has the wrong owner`);
        }
        if (typeof row.metadata.questionKey !== "string") {
          throw new Error(`LoCoMo tripwire in ${selection.sample.id} has no question key`);
        }
        tripwireRows.set(row.metadata.questionKey, row);
      }
    }
    const expectedDialogCount = selection.sample.sessions.reduce(
      (total, session) => total + session.dialogs.length,
      0,
    );
    if (
      dialogRows.size !== expectedDialogCount ||
      tripwireRows.size !== selection.questions.length ||
      rows.rows.length !== expectedDialogCount + selection.questions.length
    ) {
      throw new Error(`Indexed LoCoMo sample ${selection.sample.id} does not match the selection`);
    }

    const expectedPartition = toLocomoPartition(selection.sample, selection.questions, options);
    for (const expectedMemory of expectedPartition.memories) {
      const row =
        expectedMemory.owner === "alice"
          ? dialogRows.get(expectedMemory.key)
          : tripwireRows.get(expectedMemory.key.replace("__bob_private_tripwire__:", ""));
      if (!row) {
        throw new Error(`Indexed LoCoMo Memory ${expectedMemory.key} is missing`);
      }
      await requireExactIndexedMemory({
        client: admin,
        memoryId: row.id,
        expectedContent: expectedMemory.content,
        embeddingProvider,
        label: `${selection.sample.id}/${expectedMemory.key}`,
        requireEmbedding: expectedMemory.owner === "alice",
      });
    }
    const tripwireIds = new Set([...tripwireRows.values()].map((row) => row.id));

    for (const question of selection.questions) {
      const readerQuestion = locomoReaderQuestion(question);
      const searchStartedAt = performance.now();
      const retrieved = await searchModule.search(actor, {
        query: readerQuestion,
        limit: options.limit,
        metadataFilter: { benchmarkPartition: selection.sample.id },
      });
      const searchLatencyMs = performance.now() - searchStartedAt;
      const isolationPassed = !retrieved.some((result) => tripwireIds.has(result.memory.id));
      const retrievedDialogIds = retrieved
        .map((result) => result.memory.metadata.dialogId)
        .filter((value): value is string => typeof value === "string");
      const expectedEvidence = [...new Set(question.evidence)];
      const expectedRanks = expectedEvidence
        .map((id) => retrievedDialogIds.indexOf(id))
        .filter((rank) => rank >= 0);
      const readerStartedAt = performance.now();
      const answer = await reader.answer({
        question: readerQuestion,
        systemInstruction: LOCOMO_READER_INSTRUCTION,
        evidence: retrieved.map((result) => ({
          id:
            typeof result.memory.metadata.dialogId === "string"
              ? result.memory.metadata.dialogId
              : result.memory.id,
          text: result.evidence,
        })),
      });
      const readerLatencyMs = performance.now() - readerStartedAt;
      const prediction = answer.text.trim();
      const score = evaluateLocomoAnswer({
        prediction,
        reference: question.answer,
        category: question.category,
      });
      results.push({
        caseId: questionId(selection, question),
        sampleId: selection.sample.id,
        questionKey: question.key,
        category: question.category,
        categoryName: LOCOMO_CATEGORY_NAMES[question.category],
        question: question.question,
        reference: question.answer,
        rawPrediction: answer.text,
        prediction,
        score: rounded(score),
        retrievedDialogIds,
        annotatedEvidenceIds: expectedEvidence,
        unresolvedEvidenceIds: question.unresolvedEvidence,
        evidenceRecallAtOne: expectedEvidence.length
          ? rounded(
              expectedEvidence.filter((id) => retrievedDialogIds[0] === id).length /
                expectedEvidence.length,
            )
          : null,
        evidenceRecallAtK: expectedEvidence.length
          ? rounded(expectedRanks.length / expectedEvidence.length)
          : null,
        evidenceReciprocalRank: expectedEvidence.length
          ? rounded(expectedRanks.length ? 1 / (Math.min(...expectedRanks) + 1) : 0)
          : null,
        searchLatencyMs: rounded(searchLatencyMs, 2),
        readerLatencyMs: rounded(readerLatencyMs, 2),
        inputTokens: answer.inputTokens,
        outputTokens: answer.outputTokens,
        totalTokens: answer.totalTokens,
        readerFinishReason: answer.finishReason ?? null,
        readerNativeTimingNanoseconds: answer.nativeTimingNanoseconds ?? null,
        isolationPassed,
      });
      console.error(
        `Evaluated ${results.length}/${selectedQuestions.length}: ${questionId(selection, question)} (${rounded(score, 3)})`,
      );
    }
  }

  const readerRuntimeAfter: BenchmarkReaderRuntimeSnapshot | null =
    (await reader.inspectRuntime?.()) ?? null;
  if (JSON.stringify(readerRuntimeBefore) !== JSON.stringify(readerRuntimeAfter)) {
    throw new Error("LoCoMo reader runtime or model identity changed during the run");
  }
  const tokenUsage = summarizeTokenUsage(results);
  const evidenceCases = results.filter((result) => result.evidenceRecallAtK !== null);
  const fullEvidenceCases = evidenceCases.filter((result) => result.evidenceRecallAtK === 1);
  const anyEvidenceCases = evidenceCases.filter((result) => (result.evidenceRecallAtK ?? 0) > 0);
  const noEvidenceCases = evidenceCases.filter((result) => result.evidenceRecallAtK === 0);
  const unannotatedEvidenceCases = results.filter((result) => result.evidenceRecallAtK === null);
  const qaHardFailureCount = results.filter((result) => !result.isolationPassed).length;
  const setupHardFailureCount = retrievalReport?.hardFailureCount ?? 0;
  const hardFailureCount = qaHardFailureCount + setupHardFailureCount;
  const searchLatencies = results.map((result) => result.searchLatencyMs);
  const readerLatencies = results.map((result) => result.readerLatencyMs);
  const metricsByCategory = Object.fromEntries(
    [...new Set(results.map((result) => result.category))].sort().map((category) => {
      const categoryResults = results.filter((result) => result.category === category);
      const categoryEvidence = categoryResults.filter(
        (result) => result.evidenceRecallAtK !== null,
      );
      return [
        LOCOMO_CATEGORY_NAMES[category],
        {
          category,
          caseCount: categoryResults.length,
          answerF1: rounded(mean(categoryResults.map((result) => result.score))),
          evidenceCaseCount: categoryEvidence.length,
          evidenceRecallAtOne: categoryEvidence.length
            ? rounded(mean(categoryEvidence.map((result) => result.evidenceRecallAtOne ?? 0)))
            : null,
          evidenceRecallAtK: categoryEvidence.length
            ? rounded(mean(categoryEvidence.map((result) => result.evidenceRecallAtK ?? 0)))
            : null,
          evidenceMrr: categoryEvidence.length
            ? rounded(mean(categoryEvidence.map((result) => result.evidenceReciprocalRank ?? 0)))
            : null,
        },
      ];
    }),
  );
  const report = {
    dataset: {
      name: locomoManifest.name,
      version: locomoManifest.version,
      source: locomoManifest.source,
      revision: locomoManifest.revision,
      paper: locomoManifest.paper,
      license: locomoManifest.license,
      filename: manifestFile.filename,
      bytes: manifestFile.bytes,
      sha256: manifestFile.sha256,
    },
    selection: {
      profile,
      sampleIds: selections.map((selection) => selection.sample.id),
      requestedSampleIds: options.sampleIds ? [...options.sampleIds].sort() : null,
      sampleCount: selections.length,
      questionCount: selectedQuestions.length,
      categories: [...options.categories].sort(),
      categoryCounts: Object.fromEntries(
        [...options.categories]
          .sort()
          .map((category) => [
            LOCOMO_CATEGORY_NAMES[category],
            selectedQuestions.filter((item) => item.question.category === category).length,
          ]),
      ),
      maxCases: options.maxCases ?? null,
      casesPerCategory: options.casesPerCategory ?? null,
      caseOrderSha256,
      excludedCategory5:
        "The released adversarial split has one constant unanswerable label, so it is not reported as a standalone quality score.",
    },
    database: databaseName,
    embeddingSpace: {
      provider: embeddingProvider.provider,
      model: embeddingProvider.model,
      dimensions: embeddingProvider.dimensions,
      revision: embeddingProvider.revision,
    },
    retrieval: {
      limit: options.limit,
      semanticDistanceThreshold,
      evidenceNeighborChunks,
      evidenceTopChunks,
      evidencePolicy: RETRIEVAL_EVIDENCE_POLICY,
      contextGroupExpansion: contextGroupExpansion
        ? {
            ...contextGroupExpansion,
            policy: RETRIEVAL_CONTEXT_GROUP_POLICY,
          }
        : null,
      queryPlannerMaxQueries: queryPlanningProvider ? queryPlannerMaxQueries : null,
      queryPlanning: queryPlanningProvider
        ? {
            provider: queryPlanningProvider.provider,
            model: queryPlanningProvider.model,
            revision: queryPlanningProvider.revision ?? null,
            transport: queryPlanningProvider.transport ?? null,
            instruction: queryPlanningProvider.instruction ?? null,
            decoding: queryPlanningProvider.decoding ?? null,
            keepAlive: queryPlanningProvider.keepAlive ?? null,
          }
        : null,
      reranking: rerankingProvider
        ? {
            provider: rerankingProvider.provider,
            model: rerankingProvider.model,
            revision: rerankingProvider.revision ?? null,
            transport: rerankingProvider.transport ?? null,
            instruction: rerankingProvider.instruction ?? null,
            decoding: rerankingProvider.decoding ?? null,
            keepAlive: rerankingProvider.keepAlive ?? null,
          }
        : null,
      feedbackQueries: retrievalFeedbackQueries,
      feedbackCandidatePolicy:
        retrievalFeedbackQueries > 0 ? RETRIEVAL_FEEDBACK_CANDIDATE_POLICY : null,
      recencyWeight: retrievalRecencyWeight,
      rerankCandidateLimit: rerankingProvider ? rerankCandidateLimit : null,
      rerankDiversityLambda: rerankingProvider ? rerankDiversityLambda : null,
      rerankMinimumScore: rerankingProvider ? rerankMinimumScore : null,
      rerankWeight: rerankingProvider ? rerankWeight : null,
      setupDiagnosticSkipped: options.skipRetrievalDiagnostic,
      setupValid: retrievalReport?.valid ?? null,
      setupHardFailureCount,
      setupReport: retrievalOutputPath ?? null,
      setupVariants:
        retrievalReport?.variants.map((variant) => ({
          label: variant.label,
          metrics: variant.metrics,
        })) ?? [],
    },
    reader: {
      provider: reader.provider,
      model: reader.model,
      revision: reader.revision,
      profile: reader.profile,
      transport: reader.transport,
      instruction: LOCOMO_READER_INSTRUCTION,
      instructionSha256: sha256(LOCOMO_READER_INSTRUCTION),
      promptCompatibility: "lore-secure-short-answer-v1",
      maximumContextCharacters: reader.maximumContextCharacters,
      decoding: reader.decoding,
      keepAlive: reader.keepAlive ?? null,
      runtimeBefore: readerRuntimeBefore,
      runtimeAfter: readerRuntimeAfter,
    },
    scorer: {
      revision: LOCOMO_SCORER_REVISION,
      metric: "official-normalized-token-f1",
      porterCompatibility: "NLTK-3.8.1-default-extensions",
      llmJudge: false,
    },
    workload: metering.workload,
    metrics: {
      caseCount: results.length,
      answerF1: rounded(mean(results.map((result) => result.score))),
      evidenceCaseCount: evidenceCases.length,
      evidenceRecallAtOne: evidenceCases.length
        ? rounded(mean(evidenceCases.map((result) => result.evidenceRecallAtOne ?? 0)))
        : null,
      evidenceRecallAtK: evidenceCases.length
        ? rounded(mean(evidenceCases.map((result) => result.evidenceRecallAtK ?? 0)))
        : null,
      evidenceMrr: evidenceCases.length
        ? rounded(mean(evidenceCases.map((result) => result.evidenceReciprocalRank ?? 0)))
        : null,
      answerF1GivenFullEvidence: fullEvidenceCases.length
        ? rounded(mean(fullEvidenceCases.map((result) => result.score)))
        : null,
      fullEvidenceCaseCount: fullEvidenceCases.length,
      answerF1GivenAnyEvidence: anyEvidenceCases.length
        ? rounded(mean(anyEvidenceCases.map((result) => result.score)))
        : null,
      anyEvidenceCaseCount: anyEvidenceCases.length,
      answerF1WithoutRetrievedEvidence: noEvidenceCases.length
        ? rounded(mean(noEvidenceCases.map((result) => result.score)))
        : null,
      noRetrievedEvidenceCaseCount: noEvidenceCases.length,
      answerF1WithoutAnnotation: unannotatedEvidenceCases.length
        ? rounded(mean(unannotatedEvidenceCases.map((result) => result.score)))
        : null,
      unannotatedEvidenceCaseCount: unannotatedEvidenceCases.length,
      isolationPassed: hardFailureCount === 0,
      hardFailureCount,
      qaHardFailureCount,
      setupHardFailureCount,
      averageSearchLatencyMs: rounded(mean(searchLatencies), 2),
      p95SearchLatencyMs: rounded(percentile(searchLatencies, 0.95), 2),
      averageReaderLatencyMs: rounded(mean(readerLatencies), 2),
      p95ReaderLatencyMs: rounded(percentile(readerLatencies, 0.95), 2),
      totalInputTokens: tokenUsage.input.total,
      totalOutputTokens: tokenUsage.output.total,
      totalTokens: tokenUsage.total.total,
      readerTokenUsage: tokenUsage,
    },
    metricsByCategory,
    cases: results,
    valid:
      hardFailureCount === 0 && providerWarnings.length === 0 && (retrievalReport?.valid ?? true),
    elapsedMs: rounded(performance.now() - startedAt, 2),
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, "utf8");
    console.error(`Wrote LoCoMo report to ${outputPath}`);
    console.log(JSON.stringify({ metrics: report.metrics, valid: report.valid }, null, 2));
  } else {
    console.log(serialized.trimEnd());
  }
  if (!report.valid) process.exitCode = 1;
} finally {
  await Promise.allSettled([requestDatabase.close(), admin.end(), reader.close?.()]);
}
