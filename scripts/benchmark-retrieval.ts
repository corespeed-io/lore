import pg from "pg";
import retrievalSuite from "../evaluation/suites/retrieval-v1.json";
import { createPostgresDatabase } from "../src/lib/db/postgres";
import { createEmbeddingProviderFromEnvironment } from "../src/lib/embedding/provider-factory";
import { createMemoryMaintenanceModule } from "../src/lib/maintenance";
import { createMemoryModule, type MemoryScope } from "../src/lib/memory";
import {
  aggregateRetrievalBenchmark,
  evaluateRetrievalBenchmarkCase,
  type RetrievalBenchmarkCaseMetrics,
} from "../src/lib/retrieval-benchmark";

const databaseUrl = process.env.BENCHMARK_DATABASE_URL;
if (!databaseUrl) throw new Error("BENCHMARK_DATABASE_URL is required");

const benchmarkNamePattern = /(^|_)bench(mark)?($|_)/i;
const aliceUserId = "00000000-0000-4000-8000-000000000101";
const bobUserId = "00000000-0000-4000-8000-000000000102";
const workspaceId = "00000000-0000-4000-8000-000000000201";
const actors = {
  alice: { workspaceId, userId: aliceUserId },
  bob: { workspaceId, userId: bobUserId },
};

function benchmarkThresholds(): number[] {
  const configured = process.env.LORE_BENCHMARK_THRESHOLDS;
  const values = configured
    ? configured.split(",").map((value) => Number(value.trim()))
    : retrievalSuite.thresholds;
  if (
    values.length === 0 ||
    values.some((value) => !Number.isFinite(value) || value < 0 || value > 2)
  ) {
    throw new Error(
      "LORE_BENCHMARK_THRESHOLDS must be comma-separated cosine distances from 0 to 2",
    );
  }
  return [...new Set(values)];
}

function rounded(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function printableMetrics(metrics: ReturnType<typeof aggregateRetrievalBenchmark>) {
  return {
    ...metrics,
    recallAtOne: rounded(metrics.recallAtOne),
    recallAtK: rounded(metrics.recallAtK),
    reciprocalRank: rounded(metrics.reciprocalRank),
    ndcgAtK: rounded(metrics.ndcgAtK),
    noAnswerAccuracy: rounded(metrics.noAnswerAccuracy),
    averageFalseResults: rounded(metrics.averageFalseResults),
    averageLatencyMs: rounded(metrics.averageLatencyMs, 2),
    p50LatencyMs: rounded(metrics.p50LatencyMs, 2),
    p95LatencyMs: rounded(metrics.p95LatencyMs, 2),
  };
}

const providerWarnings: string[] = [];
const embeddingProvider = createEmbeddingProviderFromEnvironment(process.env, (message) => {
  providerWarnings.push(message);
  console.error(message);
});
if (!embeddingProvider) {
  throw new Error("The retrieval benchmark requires a valid Lore embedding provider");
}

const admin = new pg.Client({ connectionString: databaseUrl });
const requestDatabase = createPostgresDatabase({ connectionString: databaseUrl });
const maintenanceDatabase = createPostgresDatabase(
  { connectionString: databaseUrl },
  { role: "lore_maintenance" },
);
const startedAt = performance.now();

await admin.connect();
try {
  const databaseResult = await admin.query<{ name: string }>("SELECT current_database() AS name");
  const databaseName = databaseResult.rows[0]?.name ?? "";
  if (!benchmarkNamePattern.test(databaseName)) {
    throw new Error(
      `Refusing to reset retrieval data in non-benchmark database ${JSON.stringify(databaseName)}`,
    );
  }

  const schemaResult = await admin.query<{ memories: string | null; jobs: string | null }>(
    `SELECT
       to_regclass('public.memories')::text AS memories,
       to_regclass('public.memory_embedding_jobs')::text AS jobs`,
  );
  if (!schemaResult.rows[0]?.memories || !schemaResult.rows[0]?.jobs) {
    throw new Error(
      "Lore migrations are missing; run DATABASE_URL=$BENCHMARK_DATABASE_URL bun run db:migrate first",
    );
  }

  await admin.query("BEGIN");
  try {
    await admin.query("TRUNCATE users, workspaces CASCADE");
    await admin.query(
      `INSERT INTO users (id, display_name)
       VALUES ($1, 'Benchmark Alice'), ($2, 'Benchmark Bob')`,
      [aliceUserId, bobUserId],
    );
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1, 'Retrieval Benchmark')", [
      workspaceId,
    ]);
    await admin.query(
      `INSERT INTO memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [workspaceId, aliceUserId, bobUserId],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }

  const writeModule = createMemoryModule(requestDatabase, { embeddingProvider });
  const memoryIds = new Map<string, string>();
  const privateTripwireIds: string[] = [];
  console.error(`Loading ${retrievalSuite.memories.length} benchmark Memories...`);
  for (const fixture of retrievalSuite.memories) {
    if (memoryIds.has(fixture.key))
      throw new Error(`Duplicate benchmark Memory key ${fixture.key}`);
    if (fixture.owner !== "alice" && fixture.owner !== "bob") {
      throw new Error(`Unsupported benchmark owner ${fixture.owner}`);
    }
    if (fixture.scope !== "shared" && fixture.scope !== "private") {
      throw new Error(`Unsupported benchmark scope ${fixture.scope}`);
    }
    const memory = await writeModule.remember(actors[fixture.owner], {
      content: fixture.content,
      scope: fixture.scope as MemoryScope,
      metadata: { benchmarkKey: fixture.key },
    });
    memoryIds.set(fixture.key, memory.id);
    if (fixture.owner === "bob" && fixture.scope === "private") {
      privateTripwireIds.push(memory.id);
    }
  }

  const maintenanceStartedAt = performance.now();
  const maintenance = createMemoryMaintenanceModule(maintenanceDatabase, { embeddingProvider });
  let completedJobs = 0;
  while (true) {
    const result = await maintenance.run();
    if (result.status === "idle") break;
    if (result.status !== "complete") {
      throw new Error(`Embedding job ${result.jobId ?? "unknown"} ended as ${result.status}`);
    }
    completedJobs += 1;
  }
  const jobResult = await admin.query<{ status: string; count: string }>(
    `SELECT status::text, count(*)::text AS count
     FROM memory_embedding_jobs
     GROUP BY status
     ORDER BY status`,
  );
  const jobCounts = Object.fromEntries(
    jobResult.rows.map((row) => [row.status, Number(row.count)]),
  );
  if (completedJobs !== retrievalSuite.memories.length || jobCounts.succeeded !== completedJobs) {
    throw new Error(`Benchmark embeddings are incomplete: ${JSON.stringify(jobCounts)}`);
  }
  const indexingElapsedMs = performance.now() - maintenanceStartedAt;

  console.error(`Running ${retrievalSuite.cases.length} cases per retrieval variant...`);
  await embeddingProvider.embed(["Lore retrieval benchmark warmup"], "query");
  const retrievalStartedAt = performance.now();

  async function runVariant(input: {
    label: string;
    semanticDistanceThreshold?: number;
    useEmbeddings: boolean;
  }) {
    const memoryModule = createMemoryModule(requestDatabase, {
      embeddingProvider: input.useEmbeddings ? embeddingProvider : undefined,
      semanticDistanceThreshold: input.semanticDistanceThreshold,
    });
    const results: Array<{
      key: string;
      retrievedMemoryIds: string[];
      metrics: RetrievalBenchmarkCaseMetrics;
    }> = [];
    for (const benchmarkCase of retrievalSuite.cases) {
      const expectedMemoryIds = benchmarkCase.expectedKeys.map((key) => {
        const id = memoryIds.get(key);
        if (!id) throw new Error(`Unknown expected benchmark Memory key ${key}`);
        return id;
      });
      const caseStartedAt = performance.now();
      const retrieved = await memoryModule.search(actors.alice, {
        query: benchmarkCase.query,
        limit: benchmarkCase.limit,
      });
      const latencyMs = performance.now() - caseStartedAt;
      const retrievedMemoryIds = retrieved.map((result) => result.memory.id);
      results.push({
        key: benchmarkCase.key,
        retrievedMemoryIds,
        metrics: evaluateRetrievalBenchmarkCase({
          retrievedMemoryIds,
          expectedMemoryIds,
          forbiddenMemoryIds: privateTripwireIds,
          limit: benchmarkCase.limit,
          latencyMs,
        }),
      });
    }
    const metrics = aggregateRetrievalBenchmark(results.map((result) => result.metrics));
    const idToKey = new Map([...memoryIds].map(([key, id]) => [id, key]));
    return {
      label: input.label,
      semanticDistanceThreshold: input.semanticDistanceThreshold ?? null,
      metrics: printableMetrics(metrics),
      misses: results
        .filter((result) => result.metrics.noAnswerCorrect === null && result.metrics.recallAtK < 1)
        .map((result) => result.key),
      falsePositiveNoAnswerCases: results
        .filter((result) => result.metrics.noAnswerCorrect === false)
        .map((result) => ({
          key: result.key,
          retrievedKeys: result.retrievedMemoryIds.map((id) => idToKey.get(id) ?? id),
        })),
      isolationFailures: results
        .filter((result) => !result.metrics.isolationPassed)
        .map((result) => ({
          key: result.key,
          forbiddenKeys: result.metrics.forbiddenRetrievedIds.map((id) => idToKey.get(id) ?? id),
        })),
    };
  }

  const variants: Awaited<ReturnType<typeof runVariant>>[] = [
    await runVariant({ label: "lexical", useEmbeddings: false }),
  ];
  for (const threshold of benchmarkThresholds()) {
    variants.push(
      await runVariant({
        label: `hybrid@${threshold}`,
        semanticDistanceThreshold: threshold,
        useEmbeddings: true,
      }),
    );
  }

  const hardFailureCount = variants.reduce(
    (total, variant) => total + variant.metrics.hardFailureCount,
    0,
  );
  const retrievalElapsedMs = performance.now() - retrievalStartedAt;
  console.log(
    JSON.stringify(
      {
        database: databaseName,
        suite: {
          name: retrievalSuite.name,
          version: retrievalSuite.version,
          memoryCount: retrievalSuite.memories.length,
          positiveCaseCount: retrievalSuite.cases.filter(
            (benchmarkCase) => benchmarkCase.expectedKeys.length > 0,
          ).length,
          noAnswerCaseCount: retrievalSuite.cases.filter(
            (benchmarkCase) => benchmarkCase.expectedKeys.length === 0,
          ).length,
          privateTripwireCount: privateTripwireIds.length,
        },
        embeddingSpace: {
          provider: embeddingProvider.provider,
          model: embeddingProvider.model,
          dimensions: embeddingProvider.dimensions,
          revision: embeddingProvider.revision,
        },
        indexing: {
          completedJobs,
          jobCounts,
          elapsedMs: rounded(indexingElapsedMs, 2),
          memoriesPerSecond: rounded(
            retrievalSuite.memories.length / (indexingElapsedMs / 1_000),
            2,
          ),
        },
        variants,
        retrieval: {
          queryCount: retrievalSuite.cases.length * variants.length,
          elapsedMs: rounded(retrievalElapsedMs, 2),
          queriesPerSecond: rounded(
            (retrievalSuite.cases.length * variants.length) / (retrievalElapsedMs / 1_000),
            2,
          ),
        },
        warnings: providerWarnings,
        isolationPassed: hardFailureCount === 0,
        hardFailureCount,
        valid: hardFailureCount === 0 && providerWarnings.length === 0,
        elapsedMs: rounded(performance.now() - startedAt, 2),
      },
      null,
      2,
    ),
  );
  if (hardFailureCount > 0 || providerWarnings.length > 0) process.exitCode = 1;
} finally {
  await Promise.allSettled([requestDatabase.close(), maintenanceDatabase.close(), admin.end()]);
}
