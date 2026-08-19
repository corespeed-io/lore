import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { QueryPlanningProvider, RerankingProvider } from "@corespeed/lore-core";
import {
  type ActorContext,
  type ContextGroupExpansionOptions,
  createMemoryMaintenanceModule,
  createMemoryModule,
  type EmbeddingProvider,
  RETRIEVAL_CJK_LEXICAL_POLICY,
  RETRIEVAL_CONTEXT_GROUP_POLICY,
  RETRIEVAL_ENTITY_ALIAS_POLICY,
  RETRIEVAL_EVIDENCE_POLICY,
  RETRIEVAL_FEEDBACK_CANDIDATE_POLICY,
} from "@corespeed/lore-core";
import { createPostgresDatabase } from "@corespeed/lore-core/postgres";
import pg from "pg";
import {
  aggregateRetrievalBenchmark,
  evaluateRetrievalBenchmarkCase,
  type RetrievalBenchmarkCaseMetrics,
  type RetrievalBenchmarkSuiteSource,
} from "../../src/lib/retrieval-benchmark";
import { createBenchmarkMetering } from "./benchmark-metering";
import { requireExactIndexedMemory } from "./indexed-memory-validation";

const benchmarkNamePattern = /(^|_)bench(mark)?($|_)/i;
const aliceUserId = "00000000-0000-4000-8000-000000000101";
const bobUserId = "00000000-0000-4000-8000-000000000102";

interface LoadedCase {
  key: string;
  category: string;
  actor: ActorContext;
  query: string;
  metadataFilter: Record<string, unknown>;
  limit: number;
  expectedMemoryIds: string[];
  forbiddenMemoryIds: string[];
}

interface PersistedBenchmarkMemory {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  scope: "shared" | "private";
  content: string;
  benchmark_key: string;
}

function rounded(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function rate(count: number, elapsedMs: number): number {
  return elapsedMs > 0 ? rounded(count / (elapsedMs / 1_000), 2) : 0;
}

function scoreDistribution(values: Array<number | null>) {
  const scores = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((left, right) => left - right);
  const at = (fraction: number) =>
    scores.length ? scores[Math.max(0, Math.ceil(fraction * scores.length) - 1)] : null;
  return {
    count: scores.length,
    emptyCount: values.length - scores.length,
    min: scores.length ? scores[0] : null,
    p05: at(0.05),
    p50: at(0.5),
    p95: at(0.95),
    max: scores.length ? scores.at(-1) : null,
  };
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

function benchmarkThresholds(defaults: number[]): number[] {
  const configured = process.env.LORE_BENCHMARK_THRESHOLDS;
  const values = configured ? configured.split(",").map((value) => Number(value.trim())) : defaults;
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

function embeddingConcurrency(): number {
  const parsed = Number(process.env.LORE_BENCHMARK_EMBEDDING_CONCURRENCY ?? 1);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
    throw new Error("LORE_BENCHMARK_EMBEDDING_CONCURRENCY must be an integer from 1 to 32");
  }
  return parsed;
}

function unitIntervalSweep(name: string, fallback: number): number[] {
  const configured = process.env[name];
  const values = configured
    ? configured.split(",").map((value) => Number(value.trim()))
    : [fallback];
  if (
    values.length === 0 ||
    values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error(`${name} must contain comma-separated values from 0 to 1`);
  }
  return [...new Set(values)];
}

function candidateLimitSweep(fallback: number): number[] {
  const name = "LORE_BENCHMARK_RERANK_CANDIDATE_LIMITS";
  const configured = process.env[name];
  const values = configured
    ? configured.split(",").map((value) => Number(value.trim()))
    : [fallback];
  if (
    values.length === 0 ||
    values.some((value) => !Number.isInteger(value) || value < 1 || value > 100)
  ) {
    throw new Error(`${name} must contain comma-separated integers from 1 to 100`);
  }
  return [...new Set(values)];
}

function retrievalLimitSweep(): number[] {
  const name = "LORE_BENCHMARK_RETRIEVAL_LIMITS";
  const configured = process.env[name];
  if (!configured?.trim()) return [];
  const values = configured.split(",").map((value) => Number(value.trim()));
  if (
    values.length === 0 ||
    values.some((value) => !Number.isInteger(value) || value < 1 || value > 100)
  ) {
    throw new Error(`${name} must contain comma-separated integers from 1 to 100`);
  }
  return [...new Set(values)];
}

function benchmarkCacheEntries(): number {
  const parsed = Number(process.env.LORE_BENCHMARK_CACHE_ENTRIES ?? 2_000);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error("LORE_BENCHMARK_CACHE_ENTRIES must be an integer from 1 to 10000");
  }
  return parsed;
}

function cacheKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function refreshCache<Key, Value>(cache: Map<Key, Value>, key: Key, value: Value): void {
  cache.delete(key);
  cache.set(key, value);
}

function evictOldest<Key, Value>(cache: Map<Key, Value>, maximumEntries: number): void {
  while (cache.size >= maximumEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function memoizeRerankingProvider(provider: RerankingProvider): {
  provider: RerankingProvider;
  stats: { hits: number; misses: number };
} {
  const cache = new Map<string, ReturnType<RerankingProvider["rerank"]>>();
  const maximumEntries = benchmarkCacheEntries();
  const stats = { hits: 0, misses: 0 };
  return {
    stats,
    provider: {
      ...provider,
      async rerank(input) {
        const key = cacheKey(input);
        const cached = cache.get(key);
        if (cached) {
          stats.hits += 1;
          refreshCache(cache, key, cached);
          return cached;
        }
        stats.misses += 1;
        evictOldest(cache, maximumEntries);
        const pending = provider.rerank(input);
        cache.set(key, pending);
        try {
          return await pending;
        } catch (error) {
          cache.delete(key);
          throw error;
        }
      },
    },
  };
}

function memoizeQueryPlanningProvider(provider: QueryPlanningProvider): {
  provider: QueryPlanningProvider;
  stats: { hits: number; misses: number; generatedQueries: number };
} {
  const cache = new Map<string, ReturnType<QueryPlanningProvider["plan"]>>();
  const maximumEntries = benchmarkCacheEntries();
  const stats = { hits: 0, misses: 0, generatedQueries: 0 };
  return {
    stats,
    provider: {
      ...provider,
      async plan(input) {
        const key = cacheKey(input);
        const cached = cache.get(key);
        if (cached) {
          stats.hits += 1;
          refreshCache(cache, key, cached);
          return cached;
        }
        stats.misses += 1;
        evictOldest(cache, maximumEntries);
        const pending = provider.plan(input).then((queries) => {
          stats.generatedQueries += queries.length;
          return queries;
        });
        cache.set(key, pending);
        try {
          return await pending;
        } catch (error) {
          cache.delete(key);
          throw error;
        }
      },
    },
  };
}

function memoryId(memoryIds: Map<string, string>, partitionKey: string, key: string): string {
  const id = memoryIds.get(`${partitionKey}\u0000${key}`);
  if (!id) throw new Error(`Unknown benchmark Memory key ${partitionKey}/${key}`);
  return id;
}

export interface RunRetrievalBenchmarkInput {
  contextGroupExpansion?: ContextGroupExpansionOptions;
  databaseUrl: string;
  suite: RetrievalBenchmarkSuiteSource;
  embeddingProvider: EmbeddingProvider;
  evidenceNeighborChunks?: number;
  evidenceTopChunks?: number;
  queryPlanningProvider?: QueryPlanningProvider;
  queryPlannerMaxQueries?: number;
  retrievalFeedbackQueries?: number;
  retrievalRecencyWeight?: number;
  rerankingProvider?: RerankingProvider;
  rerankCandidateLimit?: number;
  rerankDiversityLambda?: number;
  rerankMinimumScore?: number;
  rerankWeight?: number;
  providerWarnings?: string[];
  outputPath?: string;
  printReport?: boolean;
  reuseIndexed?: boolean;
}

export async function runRetrievalBenchmarkSuite(input: RunRetrievalBenchmarkInput) {
  const thresholds = benchmarkThresholds(input.suite.thresholds);
  const configuredEvidenceNeighborChunks = Number(
    process.env.LORE_BENCHMARK_EVIDENCE_NEIGHBOR_CHUNKS ?? input.evidenceNeighborChunks ?? 0,
  );
  if (
    !Number.isInteger(configuredEvidenceNeighborChunks) ||
    configuredEvidenceNeighborChunks < 0 ||
    configuredEvidenceNeighborChunks > 2
  ) {
    throw new Error("LORE_BENCHMARK_EVIDENCE_NEIGHBOR_CHUNKS must be an integer from 0 to 2");
  }
  const configuredEvidenceTopChunks = Number(
    process.env.LORE_BENCHMARK_EVIDENCE_TOP_CHUNKS ?? input.evidenceTopChunks ?? 1,
  );
  if (
    !Number.isInteger(configuredEvidenceTopChunks) ||
    configuredEvidenceTopChunks < 1 ||
    configuredEvidenceTopChunks > 5
  ) {
    throw new Error("LORE_BENCHMARK_EVIDENCE_TOP_CHUNKS must be an integer from 1 to 5");
  }
  const configuredRetrievalFeedbackQueries = Number(
    process.env.LORE_BENCHMARK_RETRIEVAL_FEEDBACK_QUERIES ?? input.retrievalFeedbackQueries ?? 0,
  );
  if (
    !Number.isInteger(configuredRetrievalFeedbackQueries) ||
    configuredRetrievalFeedbackQueries < 0 ||
    configuredRetrievalFeedbackQueries > 3
  ) {
    throw new Error("LORE_BENCHMARK_RETRIEVAL_FEEDBACK_QUERIES must be an integer from 0 to 3");
  }
  const configuredRetrievalRecencyWeight = Number(
    process.env.LORE_BENCHMARK_RETRIEVAL_RECENCY_WEIGHT ?? input.retrievalRecencyWeight ?? 0,
  );
  if (
    !Number.isFinite(configuredRetrievalRecencyWeight) ||
    configuredRetrievalRecencyWeight < 0 ||
    configuredRetrievalRecencyWeight > 1
  ) {
    throw new Error("LORE_BENCHMARK_RETRIEVAL_RECENCY_WEIGHT must be between 0 and 1");
  }
  const configuredEntityAliasValue = (process.env.LORE_BENCHMARK_ENTITY_ALIAS_RECALL ?? "false")
    .trim()
    .toLowerCase();
  if (!["0", "1", "false", "true"].includes(configuredEntityAliasValue)) {
    throw new Error("LORE_BENCHMARK_ENTITY_ALIAS_RECALL must be 0, 1, false, or true");
  }
  const configuredEntityAliasRecall =
    configuredEntityAliasValue === "1" || configuredEntityAliasValue === "true";
  const indexingConcurrency = embeddingConcurrency();
  const rerankMinimumScores = unitIntervalSweep(
    "LORE_BENCHMARK_RERANK_MIN_SCORES",
    input.rerankMinimumScore ?? 0,
  );
  const rerankDiversityLambdas = unitIntervalSweep(
    "LORE_BENCHMARK_RERANK_DIVERSITY_LAMBDAS",
    input.rerankDiversityLambda ?? 1,
  );
  const rerankWeights = unitIntervalSweep("LORE_BENCHMARK_RERANK_WEIGHTS", input.rerankWeight ?? 1);
  const rerankCandidateLimits = candidateLimitSweep(input.rerankCandidateLimit ?? 50);
  const retrievalLimits = retrievalLimitSweep();
  const providerWarnings = input.providerWarnings ?? [];
  const metering = createBenchmarkMetering({
    embeddingProvider: input.embeddingProvider,
    queryPlanningProvider: input.queryPlanningProvider,
    rerankingProvider: input.rerankingProvider,
  });
  const embeddingProvider = metering.embeddingProvider;
  const memoizedReranker = metering.rerankingProvider
    ? memoizeRerankingProvider(metering.rerankingProvider)
    : undefined;
  const memoizedQueryPlanner = metering.queryPlanningProvider
    ? memoizeQueryPlanningProvider(metering.queryPlanningProvider)
    : undefined;
  const admin = new pg.Client({ connectionString: input.databaseUrl });
  const requestDatabase = createPostgresDatabase({ connectionString: input.databaseUrl });
  const maintenanceDatabase = createPostgresDatabase(
    { connectionString: input.databaseUrl },
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

    const schemaResult = await admin.query<{
      entity_alias_column: boolean;
      memories: string | null;
      jobs: string | null;
      metadata_index: string | null;
    }>(
      // The alias channel's sentinel is the generated column it scans, not an
      // index: migration 0003 dropped the request-path-dead entity-aliases GIN.
      `SELECT
         to_regclass('public.memories')::text AS memories,
         to_regclass('public.memory_embedding_jobs')::text AS jobs,
         to_regclass('public.memories_metadata_gin_idx')::text AS metadata_index,
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'memory_chunks'
             AND column_name = 'entity_aliases'
         ) AS entity_alias_column`,
    );
    if (
      !schemaResult.rows[0]?.memories ||
      !schemaResult.rows[0]?.jobs ||
      !schemaResult.rows[0]?.metadata_index
    ) {
      throw new Error(
        "Lore migrations are missing; run DATABASE_URL=$BENCHMARK_DATABASE_URL bun run db:migrate first",
      );
    }
    if (!schemaResult.rows[0]?.entity_alias_column) {
      throw new Error("Lore v1 baseline with the entity-alias column is required");
    }

    if (!input.reuseIndexed) {
      await admin.query("BEGIN");
      try {
        await admin.query("TRUNCATE users, workspaces CASCADE");
        await admin.query(
          `INSERT INTO users (id, display_name)
           VALUES ($1, 'Benchmark Alice'), ($2, 'Benchmark Bob')`,
          [aliceUserId, bobUserId],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    }

    const writeModule = createMemoryModule(requestDatabase, {
      embeddingProvider,
    });
    const tripwireWriteModule = createMemoryModule(requestDatabase);
    const memoryIds = new Map<string, string>();
    const memoryLabelsById = new Map<string, string>();
    const loadedCases: LoadedCase[] = [];
    const partitionKeys = new Set<string>();
    const categoryCounts = new Map<string, number>();
    let memoryCount = 0;
    let privateTripwireCount = 0;

    for await (const partition of input.suite.partitions) {
      if (partitionKeys.has(partition.key)) {
        throw new Error(`Duplicate benchmark partition key ${partition.key}`);
      }
      partitionKeys.add(partition.key);
      let workspaceId: string;
      let persistedMemories = new Map<string, PersistedBenchmarkMemory>();
      if (input.reuseIndexed) {
        const persistedResult = await admin.query<PersistedBenchmarkMemory>(
          `SELECT
             id,
             workspace_id,
             owner_user_id,
             scope::text,
             content,
             metadata->>'benchmarkKey' AS benchmark_key
           FROM memories
           WHERE metadata->>'benchmarkPartition' = $1
           ORDER BY id`,
          [partition.key],
        );
        const workspaceIds = new Set(persistedResult.rows.map((row) => row.workspace_id));
        if (workspaceIds.size !== 1) {
          throw new Error(
            `Indexed benchmark partition ${partition.key} must resolve to exactly one Workspace`,
          );
        }
        workspaceId = [...workspaceIds][0];
        persistedMemories = new Map(
          persistedResult.rows.map((memory) => [memory.benchmark_key, memory]),
        );
        if (
          persistedMemories.size !== persistedResult.rows.length ||
          persistedMemories.size !== partition.memories.length
        ) {
          throw new Error(`Indexed benchmark partition ${partition.key} does not match the suite`);
        }
      } else {
        workspaceId = randomUUID();
        await admin.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [
          workspaceId,
          partition.name,
        ]);
        await admin.query(
          `INSERT INTO memberships (workspace_id, user_id, role)
           VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
          [workspaceId, aliceUserId, bobUserId],
        );
      }
      const actors = {
        alice: { workspaceId, userId: aliceUserId },
        bob: { workspaceId, userId: bobUserId },
      } satisfies Record<string, ActorContext>;
      const partitionMemoryKeys = new Set<string>();
      const automaticForbiddenKeys: string[] = [];

      for (const fixture of partition.memories) {
        if (partitionMemoryKeys.has(fixture.key)) {
          throw new Error(`Duplicate benchmark Memory key ${partition.key}/${fixture.key}`);
        }
        partitionMemoryKeys.add(fixture.key);
        const expectedOwnerUserId = fixture.owner === "alice" ? aliceUserId : bobUserId;
        const isPrivateTripwire = fixture.owner === "bob" && fixture.scope === "private";
        const persistedMemory = persistedMemories.get(fixture.key);
        if (
          input.reuseIndexed &&
          (!persistedMemory ||
            persistedMemory.workspace_id !== workspaceId ||
            persistedMemory.owner_user_id !== expectedOwnerUserId ||
            persistedMemory.scope !== fixture.scope ||
            persistedMemory.content !== fixture.content)
        ) {
          throw new Error(
            `Indexed benchmark Memory ${partition.key}/${fixture.key} does not match the suite`,
          );
        }
        if (input.reuseIndexed && persistedMemory) {
          await requireExactIndexedMemory({
            client: admin,
            memoryId: persistedMemory.id,
            expectedContent: fixture.content,
            embeddingProvider,
            label: `benchmark Memory ${partition.key}/${fixture.key}`,
            requireEmbedding: !isPrivateTripwire,
          });
        }
        const memory =
          persistedMemory ??
          (await (isPrivateTripwire ? tripwireWriteModule : writeModule).remember(
            actors[fixture.owner],
            {
              content: fixture.content,
              scope: fixture.scope,
              metadata: {
                ...fixture.metadata,
                benchmarkKey: fixture.key,
                benchmarkPartition: partition.key,
              },
            },
          ));
        const qualifiedKey = `${partition.key}\u0000${fixture.key}`;
        memoryIds.set(qualifiedKey, memory.id);
        memoryLabelsById.set(memory.id, `${partition.key}/${fixture.key}`);
        memoryCount += 1;
        if (fixture.owner === "bob" && fixture.scope === "private") {
          automaticForbiddenKeys.push(fixture.key);
          privateTripwireCount += 1;
        }
        if (memoryCount % 1_000 === 0) {
          console.error(`Loaded ${memoryCount.toLocaleString()} benchmark Memories...`);
        }
      }

      const partitionCaseKeys = new Set<string>();
      for (const benchmarkCase of partition.cases) {
        if (partitionCaseKeys.has(benchmarkCase.key)) {
          throw new Error(`Duplicate benchmark case key ${partition.key}/${benchmarkCase.key}`);
        }
        partitionCaseKeys.add(benchmarkCase.key);
        const category = benchmarkCase.category ?? "uncategorized";
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
        loadedCases.push({
          key:
            partition.key === benchmarkCase.key
              ? partition.key
              : `${partition.key}/${benchmarkCase.key}`,
          category,
          actor: actors[benchmarkCase.actor ?? "alice"],
          query: benchmarkCase.query,
          metadataFilter: { benchmarkPartition: partition.key },
          limit: benchmarkCase.limit,
          expectedMemoryIds: benchmarkCase.expectedKeys.map((key) =>
            memoryId(memoryIds, partition.key, key),
          ),
          forbiddenMemoryIds: [
            ...new Set([...automaticForbiddenKeys, ...(benchmarkCase.forbiddenKeys ?? [])]),
          ].map((key) => memoryId(memoryIds, partition.key, key)),
        });
      }
    }
    if (loadedCases.length === 0) throw new Error("Retrieval benchmark suite has no cases");
    console.error(
      `${input.reuseIndexed ? "Validated" : "Loaded"} ${memoryCount.toLocaleString()} Memories across ${partitionKeys.size.toLocaleString()} isolated Workspaces.`,
    );

    const maintenanceStartedAt = performance.now();
    let completedJobs = 0;
    if (!input.reuseIndexed) {
      const maintenance = createMemoryMaintenanceModule(maintenanceDatabase, {
        embeddingProvider,
      });
      while (true) {
        const results = await Promise.all(
          Array.from({ length: indexingConcurrency }, () => maintenance.run()),
        );
        if (results.every((result) => result.status === "idle")) break;
        for (const result of results) {
          if (result.status === "idle") continue;
          if (result.status !== "complete") {
            throw new Error(`Embedding job ${result.jobId ?? "unknown"} ended as ${result.status}`);
          }
          completedJobs += 1;
        }
        if (completedJobs % 1_000 === 0) {
          console.error(`Embedded ${completedJobs.toLocaleString()} benchmark Memories...`);
        }
      }
    }
    const selectedPartitionKeys = [...partitionKeys];
    const jobResult = await admin.query<{ status: string; count: string }>(
      `SELECT job.status::text, count(*)::text AS count
       FROM memory_embedding_jobs job
       JOIN memories memory
         ON memory.workspace_id = job.workspace_id
        AND memory.id = job.memory_id
       WHERE memory.metadata->>'benchmarkPartition' = ANY($1::text[])
         AND NOT (job.owner_user_id = $2 AND job.memory_scope = 'private')
         AND job.memory_version = memory.version
         AND job.embedding_provider = $3
         AND job.embedding_model = $4
         AND job.embedding_revision = $5
       GROUP BY job.status
       ORDER BY job.status`,
      [
        selectedPartitionKeys,
        bobUserId,
        input.embeddingProvider.provider,
        input.embeddingProvider.model,
        input.embeddingProvider.revision,
      ],
    );
    const jobCounts = Object.fromEntries(
      jobResult.rows.map((row) => [row.status, Number(row.count)]),
    );
    if (input.reuseIndexed) completedJobs = jobCounts.succeeded ?? 0;
    const expectedEmbeddingCount = memoryCount - privateTripwireCount;
    if (completedJobs !== expectedEmbeddingCount || jobCounts.succeeded !== completedJobs) {
      throw new Error(`Benchmark embeddings are incomplete: ${JSON.stringify(jobCounts)}`);
    }
    const staleEmbeddingResult = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM memories memory
       WHERE memory.metadata->>'benchmarkPartition' = ANY($6::text[])
         AND NOT (memory.owner_user_id = $5 AND memory.scope = 'private')
         AND (
           NOT EXISTS (
             SELECT 1 FROM memory_chunks chunk
             WHERE chunk.workspace_id = memory.workspace_id AND chunk.memory_id = memory.id
           )
           OR EXISTS (
           SELECT 1 FROM memory_chunks chunk
           WHERE chunk.workspace_id = memory.workspace_id
             AND chunk.memory_id = memory.id
             AND NOT EXISTS (
               SELECT 1
               FROM embedding_generations generation
               JOIN memory_chunk_embeddings embedded
                 ON embedded.generation_id = generation.id
                AND embedded.workspace_id = chunk.workspace_id
                AND embedded.memory_id = chunk.memory_id
                AND embedded.chunk_id = chunk.id
               WHERE generation.embedding_provider = $1
                 AND generation.embedding_model = $2
                 AND generation.embedding_dimensions = $3
                 AND generation.embedding_revision = $4
                 AND generation.status = 'active'
               )
           )
         )`,
      [
        input.embeddingProvider.provider,
        input.embeddingProvider.model,
        input.embeddingProvider.dimensions,
        input.embeddingProvider.revision,
        bobUserId,
        selectedPartitionKeys,
      ],
    );
    if (Number(staleEmbeddingResult.rows[0]?.count ?? 0) !== 0) {
      throw new Error("Benchmark contains Memories outside the active embedding space");
    }
    const indexingElapsedMs = performance.now() - maintenanceStartedAt;

    console.error(`Running ${loadedCases.length} cases per retrieval variant...`);
    await embeddingProvider.embed(["Lore retrieval benchmark warmup"], "query");
    const retrievalStartedAt = performance.now();

    async function runVariant(variant: {
      label: string;
      semanticDistanceThreshold?: number;
      useEmbeddings: boolean;
      useContextGroupExpansion?: boolean;
      useEntityAliases?: boolean;
      useQueryPlanning?: boolean;
      useRetrievalFeedback?: boolean;
      useRecency?: boolean;
      useReranking?: boolean;
      retrievalLimit?: number;
      rerankCandidateLimit?: number;
      rerankDiversityLambda?: number;
      rerankMinimumScore?: number;
      rerankWeight?: number;
    }) {
      const queryPlanningCallsBefore = metering.workload.queryPlanning?.calls ?? 0;
      const queryPlanningCacheHitsBefore = memoizedQueryPlanner?.stats.hits ?? 0;
      const queryPlanningCacheMissesBefore = memoizedQueryPlanner?.stats.misses ?? 0;
      const rerankingCallsBefore = metering.workload.reranking?.calls ?? 0;
      const rerankingCacheHitsBefore = memoizedReranker?.stats.hits ?? 0;
      const rerankingCacheMissesBefore = memoizedReranker?.stats.misses ?? 0;
      const memoryModule = createMemoryModule(requestDatabase, {
        contextGroupExpansion: variant.useContextGroupExpansion
          ? input.contextGroupExpansion
          : undefined,
        embeddingProvider: variant.useEmbeddings ? embeddingProvider : undefined,
        entityAliasRecall: variant.useEntityAliases ?? false,
        evidenceNeighborChunks: configuredEvidenceNeighborChunks,
        evidenceTopChunks: configuredEvidenceTopChunks,
        queryPlanningProvider: variant.useQueryPlanning
          ? memoizedQueryPlanner?.provider
          : undefined,
        queryPlannerMaxQueries: input.queryPlannerMaxQueries,
        retrievalFeedbackQueries: variant.useRetrievalFeedback
          ? configuredRetrievalFeedbackQueries
          : 0,
        retrievalRecencyWeight: variant.useRecency ? configuredRetrievalRecencyWeight : 0,
        rerankingProvider: variant.useReranking ? memoizedReranker?.provider : undefined,
        rerankCandidateLimit: variant.rerankCandidateLimit,
        rerankDiversityLambda: variant.rerankDiversityLambda,
        rerankMinimumScore: variant.rerankMinimumScore,
        rerankWeight: variant.rerankWeight,
        semanticDistanceThreshold: variant.semanticDistanceThreshold,
      });
      const results: Array<{
        key: string;
        category: string;
        retrievedMemoryIds: string[];
        topRerankScore: number | null;
        metrics: RetrievalBenchmarkCaseMetrics;
      }> = [];
      for (const benchmarkCase of loadedCases) {
        const caseStartedAt = performance.now();
        const retrieved = await memoryModule.search(benchmarkCase.actor, {
          query: benchmarkCase.query,
          limit: variant.retrievalLimit ?? benchmarkCase.limit,
          metadataFilter: benchmarkCase.metadataFilter,
        });
        const retrievedMemoryIds = retrieved.map((result) => result.memory.id);
        results.push({
          key: benchmarkCase.key,
          category: benchmarkCase.category,
          retrievedMemoryIds,
          topRerankScore: retrieved[0]?.rerankScore ?? null,
          metrics: evaluateRetrievalBenchmarkCase({
            retrievedMemoryIds,
            expectedMemoryIds: benchmarkCase.expectedMemoryIds,
            forbiddenMemoryIds: benchmarkCase.forbiddenMemoryIds,
            limit: variant.retrievalLimit ?? benchmarkCase.limit,
            latencyMs: performance.now() - caseStartedAt,
          }),
        });
        if (results.length % 250 === 0 || results.length === loadedCases.length) {
          console.error(
            `Completed ${results.length.toLocaleString()}/${loadedCases.length.toLocaleString()} cases for ${variant.label}...`,
          );
        }
      }
      const metrics = aggregateRetrievalBenchmark(results.map((result) => result.metrics));
      const metricsByCategory = Object.fromEntries(
        [...categoryCounts.keys()]
          .sort()
          .map((category) => [
            category,
            printableMetrics(
              aggregateRetrievalBenchmark(
                results
                  .filter((result) => result.category === category)
                  .map((result) => result.metrics),
              ),
            ),
          ]),
      );
      const queryPlanningCacheHits =
        (memoizedQueryPlanner?.stats.hits ?? 0) - queryPlanningCacheHitsBefore;
      const queryPlanningCacheMisses =
        (memoizedQueryPlanner?.stats.misses ?? 0) - queryPlanningCacheMissesBefore;
      const rerankingCacheHits = (memoizedReranker?.stats.hits ?? 0) - rerankingCacheHitsBefore;
      const rerankingCacheMisses =
        (memoizedReranker?.stats.misses ?? 0) - rerankingCacheMissesBefore;
      return {
        label: variant.label,
        contextGroupExpansion: variant.useContextGroupExpansion
          ? input.contextGroupExpansion
          : null,
        entityAliasRecall: variant.useEntityAliases ?? false,
        queryPlanning: variant.useQueryPlanning ?? false,
        retrievalFeedbackQueries: variant.useRetrievalFeedback
          ? configuredRetrievalFeedbackQueries
          : 0,
        retrievalRecencyWeight: variant.useRecency ? configuredRetrievalRecencyWeight : 0,
        retrievalLimit: variant.retrievalLimit ?? null,
        rerankCandidateLimit: variant.rerankCandidateLimit ?? null,
        rerankDiversityLambda: variant.rerankDiversityLambda ?? null,
        rerankMinimumScore: variant.rerankMinimumScore ?? null,
        rerankWeight: variant.rerankWeight ?? null,
        semanticDistanceThreshold: variant.semanticDistanceThreshold ?? null,
        providerExecution: {
          queryPlanning: variant.useQueryPlanning
            ? {
                providerCalls:
                  (metering.workload.queryPlanning?.calls ?? 0) - queryPlanningCallsBefore,
                cacheHits: queryPlanningCacheHits,
                cacheMisses: queryPlanningCacheMisses,
                latencyComparableToOnline: queryPlanningCacheHits === 0,
              }
            : null,
          reranking: variant.useReranking
            ? {
                providerCalls: (metering.workload.reranking?.calls ?? 0) - rerankingCallsBefore,
                cacheHits: rerankingCacheHits,
                cacheMisses: rerankingCacheMisses,
                latencyComparableToOnline: rerankingCacheHits === 0,
              }
            : null,
        },
        metrics: printableMetrics(metrics),
        metricsByCategory,
        caseMetrics: results.map((result) => ({
          key: result.key,
          category: result.category,
          expectedCount:
            loadedCases.find((benchmarkCase) => benchmarkCase.key === result.key)?.expectedMemoryIds
              .length ?? 0,
          retrievedCount: result.retrievedMemoryIds.length,
          recallAtOne: rounded(result.metrics.recallAtOne),
          recallAtK: rounded(result.metrics.recallAtK),
          reciprocalRank: rounded(result.metrics.reciprocalRank),
          ndcgAtK: rounded(result.metrics.ndcgAtK),
          isolationPassed: result.metrics.isolationPassed,
          latencyMs: rounded(result.metrics.latencyMs, 2),
          topRerankScore: result.topRerankScore,
        })),
        scoreCalibration: variant.useReranking
          ? {
              positiveTopRerankScore: scoreDistribution(
                results
                  .filter((result) => result.metrics.noAnswerCorrect === null)
                  .map((result) => result.topRerankScore),
              ),
              noAnswerTopRerankScore: scoreDistribution(
                results
                  .filter((result) => result.metrics.noAnswerCorrect !== null)
                  .map((result) => result.topRerankScore),
              ),
            }
          : null,
        misses: results
          .filter(
            (result) => result.metrics.noAnswerCorrect === null && result.metrics.recallAtK < 1,
          )
          .map((result) => {
            const benchmarkCase = loadedCases.find((item) => item.key === result.key);
            return {
              key: result.key,
              expectedKeys: (benchmarkCase?.expectedMemoryIds ?? []).map(
                (id) => memoryLabelsById.get(id) ?? id,
              ),
              retrievedKeys: result.retrievedMemoryIds.map((id) => memoryLabelsById.get(id) ?? id),
            };
          }),
        falsePositiveNoAnswerCases: results
          .filter((result) => result.metrics.noAnswerCorrect === false)
          .map((result) => ({
            key: result.key,
            retrievedKeys: result.retrievedMemoryIds.map((id) => memoryLabelsById.get(id) ?? id),
          })),
        isolationFailures: results
          .filter((result) => !result.metrics.isolationPassed)
          .map((result) => ({
            key: result.key,
            forbiddenKeys: result.metrics.forbiddenRetrievedIds.map(
              (id) => memoryLabelsById.get(id) ?? id,
            ),
          })),
      };
    }

    const variants: Awaited<ReturnType<typeof runVariant>>[] = [
      await runVariant({ label: "lexical", useEmbeddings: false }),
    ];
    if (configuredEntityAliasRecall) {
      variants.push(
        await runVariant({
          label: "lexical+entity-alias",
          useEmbeddings: false,
          useEntityAliases: true,
        }),
      );
    }
    if (input.queryPlanningProvider) {
      variants.push(
        await runVariant({
          label: "lexical+planner",
          useEmbeddings: false,
          useQueryPlanning: true,
        }),
      );
    }
    for (const threshold of thresholds) {
      variants.push(
        await runVariant({
          label: `hybrid@${threshold}`,
          semanticDistanceThreshold: threshold,
          useEmbeddings: true,
        }),
      );
      for (const retrievalLimit of retrievalLimits) {
        variants.push(
          await runVariant({
            label: `hybrid-depth@${threshold}|limit=${retrievalLimit}`,
            semanticDistanceThreshold: threshold,
            useEmbeddings: true,
            retrievalLimit,
          }),
        );
      }
      if (configuredEntityAliasRecall) {
        variants.push(
          await runVariant({
            label: `hybrid+entity-alias@${threshold}`,
            semanticDistanceThreshold: threshold,
            useEmbeddings: true,
            useEntityAliases: true,
          }),
        );
      }
      if (configuredRetrievalFeedbackQueries > 0) {
        variants.push(
          await runVariant({
            label: `hybrid+feedback@${threshold}|queries=${configuredRetrievalFeedbackQueries}`,
            semanticDistanceThreshold: threshold,
            useEmbeddings: true,
            useRetrievalFeedback: true,
          }),
        );
      }
      if (configuredRetrievalRecencyWeight > 0) {
        variants.push(
          await runVariant({
            label: `hybrid+recency@${threshold}|candidates=${input.rerankCandidateLimit ?? 50}|weight=${configuredRetrievalRecencyWeight}`,
            semanticDistanceThreshold: threshold,
            useEmbeddings: true,
            useRecency: true,
            rerankCandidateLimit: input.rerankCandidateLimit ?? 50,
          }),
        );
      }
      if (input.queryPlanningProvider) {
        variants.push(
          await runVariant({
            label: `hybrid+planner@${threshold}`,
            semanticDistanceThreshold: threshold,
            useEmbeddings: true,
            useQueryPlanning: true,
          }),
        );
        if (configuredRetrievalFeedbackQueries > 0) {
          variants.push(
            await runVariant({
              label: `hybrid+planner+feedback@${threshold}|queries=${configuredRetrievalFeedbackQueries}`,
              semanticDistanceThreshold: threshold,
              useEmbeddings: true,
              useQueryPlanning: true,
              useRetrievalFeedback: true,
            }),
          );
        }
      }
      if (input.contextGroupExpansion) {
        for (const candidateLimit of rerankCandidateLimits) {
          variants.push(
            await runVariant({
              label: `hybrid+context-candidates@${threshold}|candidates=${candidateLimit}`,
              semanticDistanceThreshold: threshold,
              useEmbeddings: true,
              useContextGroupExpansion: true,
              retrievalLimit: candidateLimit,
              rerankCandidateLimit: candidateLimit,
            }),
          );
        }
      }
      if (input.rerankingProvider) {
        for (const candidateLimit of rerankCandidateLimits) {
          variants.push(
            await runVariant({
              label: `hybrid-candidates@${threshold}|candidates=${candidateLimit}`,
              semanticDistanceThreshold: threshold,
              useEmbeddings: true,
              retrievalLimit: candidateLimit,
            }),
          );
          for (const minimumScore of rerankMinimumScores) {
            for (const diversityLambda of rerankDiversityLambdas) {
              for (const weight of rerankWeights) {
                variants.push(
                  await runVariant({
                    label: `hybrid+rerank@${threshold}|candidates=${candidateLimit}|min=${minimumScore}|lambda=${diversityLambda}|weight=${weight}`,
                    semanticDistanceThreshold: threshold,
                    useEmbeddings: true,
                    useReranking: true,
                    rerankCandidateLimit: candidateLimit,
                    rerankDiversityLambda: diversityLambda,
                    rerankMinimumScore: minimumScore,
                    rerankWeight: weight,
                  }),
                );
                if (input.contextGroupExpansion) {
                  variants.push(
                    await runVariant({
                      label: `hybrid+context+rerank@${threshold}|candidates=${candidateLimit}|min=${minimumScore}|lambda=${diversityLambda}|weight=${weight}`,
                      semanticDistanceThreshold: threshold,
                      useEmbeddings: true,
                      useContextGroupExpansion: true,
                      useReranking: true,
                      rerankCandidateLimit: candidateLimit,
                      rerankDiversityLambda: diversityLambda,
                      rerankMinimumScore: minimumScore,
                      rerankWeight: weight,
                    }),
                  );
                }
                if (configuredRetrievalFeedbackQueries > 0) {
                  variants.push(
                    await runVariant({
                      label: `hybrid+feedback+rerank@${threshold}|queries=${configuredRetrievalFeedbackQueries}|candidates=${candidateLimit}|min=${minimumScore}|lambda=${diversityLambda}|weight=${weight}`,
                      semanticDistanceThreshold: threshold,
                      useEmbeddings: true,
                      useRetrievalFeedback: true,
                      useReranking: true,
                      rerankCandidateLimit: candidateLimit,
                      rerankDiversityLambda: diversityLambda,
                      rerankMinimumScore: minimumScore,
                      rerankWeight: weight,
                    }),
                  );
                }
                if (input.queryPlanningProvider) {
                  variants.push(
                    await runVariant({
                      label: `hybrid+planner+rerank@${threshold}|candidates=${candidateLimit}|min=${minimumScore}|lambda=${diversityLambda}|weight=${weight}`,
                      semanticDistanceThreshold: threshold,
                      useEmbeddings: true,
                      useQueryPlanning: true,
                      useReranking: true,
                      rerankCandidateLimit: candidateLimit,
                      rerankDiversityLambda: diversityLambda,
                      rerankMinimumScore: minimumScore,
                      rerankWeight: weight,
                    }),
                  );
                  if (configuredRetrievalFeedbackQueries > 0) {
                    variants.push(
                      await runVariant({
                        label: `hybrid+planner+feedback+rerank@${threshold}|queries=${configuredRetrievalFeedbackQueries}|candidates=${candidateLimit}|min=${minimumScore}|lambda=${diversityLambda}|weight=${weight}`,
                        semanticDistanceThreshold: threshold,
                        useEmbeddings: true,
                        useQueryPlanning: true,
                        useRetrievalFeedback: true,
                        useReranking: true,
                        rerankCandidateLimit: candidateLimit,
                        rerankDiversityLambda: diversityLambda,
                        rerankMinimumScore: minimumScore,
                        rerankWeight: weight,
                      }),
                    );
                  }
                }
              }
            }
          }
        }
      }
    }

    const hardFailureCount = variants.reduce(
      (total, variant) => total + variant.metrics.hardFailureCount,
      0,
    );
    const retrievalElapsedMs = performance.now() - retrievalStartedAt;
    const valid = hardFailureCount === 0 && providerWarnings.length === 0;
    const report = {
      database: databaseName,
      suite: {
        name: input.suite.name,
        version: input.suite.version,
        description: input.suite.description,
        provenance: input.suite.provenance ?? null,
        partitionCount: partitionKeys.size,
        memoryCount,
        caseCount: loadedCases.length,
        categoryCounts: Object.fromEntries(
          [...categoryCounts].sort(([left], [right]) => left.localeCompare(right)),
        ),
        privateTripwireCount,
      },
      embeddingSpace: {
        provider: input.embeddingProvider.provider,
        model: input.embeddingProvider.model,
        dimensions: input.embeddingProvider.dimensions,
        revision: input.embeddingProvider.revision,
      },
      evidenceNeighborChunks: configuredEvidenceNeighborChunks,
      evidenceTopChunks: configuredEvidenceTopChunks,
      evidencePolicy: RETRIEVAL_EVIDENCE_POLICY,
      cjkLexicalPolicy: RETRIEVAL_CJK_LEXICAL_POLICY,
      entityAliasRecall: configuredEntityAliasRecall,
      entityAliasPolicy: configuredEntityAliasRecall ? RETRIEVAL_ENTITY_ALIAS_POLICY : null,
      contextGroupExpansion: input.contextGroupExpansion
        ? {
            ...input.contextGroupExpansion,
            policy: RETRIEVAL_CONTEXT_GROUP_POLICY,
          }
        : null,
      retrievalFeedbackQueries: configuredRetrievalFeedbackQueries,
      retrievalFeedbackCandidatePolicy:
        configuredRetrievalFeedbackQueries > 0 ? RETRIEVAL_FEEDBACK_CANDIDATE_POLICY : null,
      retrievalRecencyWeight: configuredRetrievalRecencyWeight,
      retrievalLimitSweep: retrievalLimits,
      reranking: input.rerankingProvider
        ? {
            provider: input.rerankingProvider.provider,
            model: input.rerankingProvider.model,
            revision: input.rerankingProvider.revision ?? null,
            instruction: input.rerankingProvider.instruction ?? null,
            transport: input.rerankingProvider.transport ?? null,
            decoding: input.rerankingProvider.decoding ?? null,
            keepAlive: input.rerankingProvider.keepAlive ?? null,
            candidateLimits: rerankCandidateLimits,
            diversityLambdas: rerankDiversityLambdas,
            minimumScores: rerankMinimumScores,
            weights: rerankWeights,
            benchmarkCache: memoizedReranker?.stats ?? null,
          }
        : null,
      queryPlanning: input.queryPlanningProvider
        ? {
            provider: input.queryPlanningProvider.provider,
            model: input.queryPlanningProvider.model,
            revision: input.queryPlanningProvider.revision ?? null,
            transport: input.queryPlanningProvider.transport ?? null,
            instruction: input.queryPlanningProvider.instruction ?? null,
            decoding: input.queryPlanningProvider.decoding ?? null,
            keepAlive: input.queryPlanningProvider.keepAlive ?? null,
            maximumQueries: input.queryPlannerMaxQueries ?? 3,
            benchmarkCache: memoizedQueryPlanner?.stats ?? null,
          }
        : null,
      indexing: {
        reused: input.reuseIndexed ?? false,
        completedJobs,
        concurrency: input.reuseIndexed ? null : indexingConcurrency,
        jobCounts,
        elapsedMs: input.reuseIndexed ? null : rounded(indexingElapsedMs, 2),
        memoriesPerSecond: input.reuseIndexed ? null : rate(memoryCount, indexingElapsedMs),
        validationElapsedMs: input.reuseIndexed ? rounded(indexingElapsedMs, 2) : null,
      },
      variants,
      retrieval: {
        queryCount: loadedCases.length * variants.length,
        elapsedMs: rounded(retrievalElapsedMs, 2),
        queriesPerSecond: rate(loadedCases.length * variants.length, retrievalElapsedMs),
      },
      workload: metering.workload,
      warnings: providerWarnings,
      isolationPassed: hardFailureCount === 0,
      hardFailureCount,
      valid,
      elapsedMs: rounded(performance.now() - startedAt, 2),
    };
    const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
    if (input.outputPath) {
      const outputPath = resolve(input.outputPath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, serializedReport, "utf8");
      console.error(`Wrote benchmark report to ${outputPath}`);
    }
    if (input.printReport !== false) console.log(serializedReport.trimEnd());
    return report;
  } finally {
    await Promise.allSettled([requestDatabase.close(), maintenanceDatabase.close(), admin.end()]);
  }
}
