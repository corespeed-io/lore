import { resolve } from "node:path";
import { MEMORY_CHUNKING_REVISION } from "@corespeed/lore-core";
import { createEmbeddingProviderFromEnvironment } from "../../../src/server/providers/embedding/factory";
import { createQueryPlanningProviderFromEnvironment } from "../../../src/server/providers/query-planning/factory";
import { createRerankingProviderFromEnvironment } from "../../../src/server/providers/reranking/factory";
import { strictRetrievalKnobsFromEnvironment } from "../../../src/server/providers/retrieval-knobs";
import { verifyFile } from "../shared/file-integrity";
import {
  chunkMemoryAgentBenchAccurateContext,
  memoryAgentBenchLiteralAnswerChunkIndex,
  memoryAgentBenchManifest,
  readMemoryAgentBenchRows,
} from "./memoryagentbench";
import type { RetrievalBenchmarkPartition } from "./retrieval";
import { runRetrievalBenchmarkSuite } from "./retrieval-suite";

interface CliOptions {
  limit: number;
  maxQuestions: number;
  maxSources: number;
  outputPath?: string;
  plan: boolean;
  reuseIndexed: boolean;
  rowIndex?: number;
  source?: string;
}

function positiveInteger(value: string | undefined, flag: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${flag} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    limit: 10,
    maxQuestions: 20,
    maxSources: 1,
    plan: false,
    reuseIndexed: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--limit") {
      options.limit = positiveInteger(value, flag, 100);
      index += 1;
    } else if (flag === "--max-questions") {
      options.maxQuestions = positiveInteger(value, flag, 100);
      index += 1;
    } else if (flag === "--max-sources") {
      options.maxSources = positiveInteger(value, flag, 22);
      index += 1;
    } else if (flag === "--output") {
      if (!value?.trim()) throw new Error("--output requires a path");
      options.outputPath = value;
      index += 1;
    } else if (flag === "--row-index") {
      const rowIndex = Number(value);
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= 22) {
        throw new Error("--row-index must be an integer from 0 to 21");
      }
      options.rowIndex = rowIndex;
      index += 1;
    } else if (flag === "--source") {
      if (!value?.trim()) throw new Error("--source requires a source name");
      options.source = value.trim();
      index += 1;
    } else if (flag === "--plan") {
      options.plan = true;
    } else if (flag === "--reuse-indexed") {
      options.reuseIndexed = true;
    } else {
      throw new Error(`Unknown MemoryAgentBench Accurate Retrieval option ${flag}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const databaseUrl = process.env.BENCHMARK_DATABASE_URL;
if (!databaseUrl && !options.plan) throw new Error("BENCHMARK_DATABASE_URL is required");
const file = memoryAgentBenchManifest.files.accurate;
const dataDirectory = resolve(
  process.env.LORE_MEMORYAGENTBENCH_DATA_DIR ?? "evaluation/datasets/memoryagentbench",
);
const dataPath = resolve(dataDirectory, file.path);
await verifyFile(dataPath, file);
const allRows = await readMemoryAgentBenchRows(dataPath);
const indexedRows = allRows.map((row, rowIndex) => ({ row, rowIndex }));
const selectedRows = (
  options.rowIndex === undefined
    ? indexedRows.filter(({ row }) => !options.source || row.metadata.source === options.source)
    : indexedRows.filter(({ rowIndex }) => rowIndex === options.rowIndex)
).slice(0, options.maxSources);
if (!selectedRows.length) throw new Error("MemoryAgentBench selection contains no source rows");

const prepared = selectedRows.map(({ row, rowIndex }) => {
  const chunks = chunkMemoryAgentBenchAccurateContext(row.context);
  const attemptedQuestions = Math.min(options.maxQuestions, row.questions.length);
  const anchored = Array.from({ length: attemptedQuestions }, (_, questionIndex) => {
    const anchorIndex = memoryAgentBenchLiteralAnswerChunkIndex(
      chunks,
      row.questions[questionIndex],
      row.answers[questionIndex],
    );
    return anchorIndex === null ? null : { anchorIndex, questionIndex };
  }).filter((item): item is { anchorIndex: number; questionIndex: number } => item !== null);
  const partitionKey = `memoryagentbench-accurate:${rowIndex}:${row.metadata.source}`;
  return {
    anchored,
    attemptedQuestions,
    chunks,
    partition: {
      key: partitionKey,
      name: `MemoryAgentBench Accurate Retrieval ${row.metadata.source} row ${rowIndex}`,
      memories: [
        ...chunks.map((content, chunkIndex) => ({
          key: `chunk:${chunkIndex}`,
          owner: "alice" as const,
          scope: "shared" as const,
          content,
          metadata: { chunkIndex, rowIndex, source: row.metadata.source },
        })),
        ...anchored.map(({ questionIndex }) => ({
          key: `tripwire:${row.metadata.qa_pair_ids[questionIndex]}`,
          owner: "bob" as const,
          scope: "private" as const,
          content: `Private answer tripwire\nQuestion: ${row.questions[questionIndex]}\nAnswer: ${row.answers[questionIndex].join(" | ")}`,
          metadata: {
            questionId: row.metadata.qa_pair_ids[questionIndex],
            recordType: "tripwire",
            rowIndex,
            source: row.metadata.source,
          },
        })),
      ],
      cases: anchored.map(({ anchorIndex, questionIndex }) => ({
        key: row.metadata.qa_pair_ids[questionIndex],
        category:
          Array.isArray(row.metadata.question_types) &&
          typeof row.metadata.question_types[questionIndex] === "string"
            ? row.metadata.question_types[questionIndex]
            : row.metadata.source,
        query: row.questions[questionIndex],
        expectedKeys: [`chunk:${anchorIndex}`],
        limit: options.limit,
      })),
    } satisfies RetrievalBenchmarkPartition,
    rowIndex,
    source: row.metadata.source,
  };
});
const selection = {
  diagnostic: "literal-answer-anchor-retrieval",
  officialEndAnswerScore: false,
  sourceRows: prepared.map((item) => ({
    rowIndex: item.rowIndex,
    source: item.source,
    memoryChunks: item.chunks.length,
    attemptedQuestions: item.attemptedQuestions,
    anchoredQuestions: item.anchored.length,
  })),
  partitionCount: prepared.length,
  memoryChunkCount: prepared.reduce((total, item) => total + item.chunks.length, 0),
  attemptedQuestionCount: prepared.reduce((total, item) => total + item.attemptedQuestions, 0),
  anchoredQuestionCount: prepared.reduce((total, item) => total + item.anchored.length, 0),
  retrievalLimit: options.limit,
};
if (options.plan) {
  console.log(JSON.stringify({ dataset: memoryAgentBenchManifest.name, selection }, null, 2));
  process.exit(0);
}
if (selection.anchoredQuestionCount === 0) {
  throw new Error("MemoryAgentBench selection contains no literal answer anchors");
}

const providerWarnings: string[] = [];
const warn = (message: string) => {
  providerWarnings.push(message);
  console.error(message);
};
const embeddingProvider = createEmbeddingProviderFromEnvironment(process.env, warn);
if (!embeddingProvider) throw new Error("MemoryAgentBench requires a valid embedding provider");
const queryPlanningProvider = createQueryPlanningProviderFromEnvironment(process.env, warn);
const rerankingProvider = createRerankingProviderFromEnvironment(process.env, warn);
// The deployment's own knob table, strictly: a benchmark refuses an invalid value.
const retrievalKnobs = strictRetrievalKnobsFromEnvironment(process.env);
const report = await runRetrievalBenchmarkSuite({
  databaseUrl: databaseUrl as string,
  embeddingProvider,
  evidenceNeighborChunks: retrievalKnobs.evidenceNeighborChunks,
  evidenceTopChunks: retrievalKnobs.evidenceTopChunks,
  queryPlanningProvider,
  queryPlannerMaxQueries: retrievalKnobs.queryPlannerMaxQueries,
  retrievalFeedbackQueries: retrievalKnobs.retrievalFeedbackQueries,
  retrievalRecencyWeight: retrievalKnobs.retrievalRecencyWeight,
  rerankingProvider,
  rerankCandidateLimit: retrievalKnobs.rerankCandidateLimit,
  rerankDiversityLambda: retrievalKnobs.rerankDiversityLambda,
  rerankMinimumScore: retrievalKnobs.rerankMinimumScore,
  rerankWeight: retrievalKnobs.rerankWeight,
  providerWarnings,
  outputPath: options.outputPath,
  reuseIndexed: options.reuseIndexed,
  suite: {
    name: `${memoryAgentBenchManifest.name} Accurate Retrieval diagnostic`,
    version: memoryAgentBenchManifest.version,
    description:
      "Pinned Accurate Retrieval rows chunked into independent Lore Memories with literal answer anchors and private tripwires.",
    thresholds: [0.35, 0.4, 0.45, 0.5],
    provenance: {
      source: memoryAgentBenchManifest.source,
      revision: memoryAgentBenchManifest.revision,
      codeRevision: memoryAgentBenchManifest.codeRevision,
      file: file.path,
      sha256: file.sha256,
      chunking: `memoryagentbench-document-aware-v3+${MEMORY_CHUNKING_REVISION}`,
      selection,
    },
    partitions: (async function* () {
      for (const item of prepared) {
        if (item.partition.cases.length > 0) yield item.partition;
      }
    })(),
  },
});
if (!report.valid) process.exitCode = 1;
