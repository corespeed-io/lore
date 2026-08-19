/**
 * Source-derived end-to-end benchmark for the public CodeIndexModule seam.
 *
 * The target must be a migrated disposable database whose name contains
 * "benchmark". The harness clears tenant data, indexes one exact local Git
 * commit under RLS, installs a forbidden-Workspace tripwire, and measures the
 * public search method with warm-cache concurrency.
 */
import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { ActorContext } from "@corespeed/lore-core";
import { createMemoryModule } from "@corespeed/lore-core";
import { createPostgresDatabase } from "@corespeed/lore-core/postgres";
import { Client } from "pg";
import { createCodeEvidenceModule } from "../src/lib/code-evidence";
import { createCodeDependencyGraphModule } from "../src/lib/code-graph";
import { createCodeIndexModule } from "../src/lib/code-index";
import { createContextRetrievalModule } from "../src/lib/context-retrieval";

const execFileAsync = promisify(execFile);
const BENCHMARK_REVISION = "code-index-performance-v4-derived-sets";
const databaseUrl = process.env.CODE_INDEX_BENCHMARK_DATABASE_URL;
if (!databaseUrl) throw new Error("CODE_INDEX_BENCHMARK_DATABASE_URL is required");

function integerArgument(name: string, fallback: number): number {
  const flag = process.argv.indexOf(`--${name}`);
  const value = flag === -1 ? fallback : Number(process.argv[flag + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be positive`);
  return value;
}

function stringArgument(name: string, fallback: string): string {
  const flag = process.argv.indexOf(`--${name}`);
  const value = flag === -1 ? fallback : process.argv[flag + 1];
  if (!value) throw new Error(`--${name} must not be empty`);
  return value;
}

function optionalStringArgument(name: string): string | null {
  const flag = process.argv.indexOf(`--${name}`);
  if (flag === -1) return null;
  const value = process.argv[flag + 1];
  if (!value) throw new Error(`--${name} must not be empty`);
  return value;
}

function repeatedArguments(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== `--${name}`) continue;
    const value = process.argv[index + 1];
    if (!value) throw new Error(`--${name} must not be empty`);
    values.push(value);
  }
  return values;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function distribution(samples: number[]) {
  samples.sort((left, right) => left - right);
  return {
    count: samples.length,
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    p99Ms: Number(percentile(samples, 0.99).toFixed(3)),
    maxMs: Number((samples.at(-1) ?? 0).toFixed(3)),
  };
}

interface PhaseMetrics {
  elapsedMs: number;
  userCpuMs: number;
  systemCpuMs: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  sampledPeakRssBytes: number;
  heapUsedBeforeBytes: number;
  heapUsedAfterBytes: number;
}

async function measurePhase<T>(operation: () => Promise<T>): Promise<{
  metrics: PhaseMetrics;
  result: T;
}> {
  const beforeMemory = process.memoryUsage();
  const beforeUsage = process.resourceUsage();
  let sampledPeakRssBytes = beforeMemory.rss;
  const sampler = setInterval(() => {
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
  }, 25);
  sampler.unref();
  const startedAt = performance.now();
  try {
    const result = await operation();
    const afterMemory = process.memoryUsage();
    const afterUsage = process.resourceUsage();
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, afterMemory.rss);
    return {
      result,
      metrics: {
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        userCpuMs: Number(((afterUsage.userCPUTime - beforeUsage.userCPUTime) / 1_000).toFixed(1)),
        systemCpuMs: Number(
          ((afterUsage.systemCPUTime - beforeUsage.systemCPUTime) / 1_000).toFixed(1),
        ),
        rssBeforeBytes: beforeMemory.rss,
        rssAfterBytes: afterMemory.rss,
        sampledPeakRssBytes,
        heapUsedBeforeBytes: beforeMemory.heapUsed,
        heapUsedAfterBytes: afterMemory.heapUsed,
      },
    };
  } finally {
    clearInterval(sampler);
  }
}

const repositoryPath = await realpath(stringArgument("repository", process.cwd()));
const requestedCommit = stringArgument("commit", "HEAD");
async function resolveCommit(revision: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    repositoryPath,
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]);
  return stdout.trim().toLowerCase();
}
const commitOid = await resolveCommit(requestedCommit);
const explicitBaseCommit = optionalStringArgument("base-commit");
const requestedBaseCommit = explicitBaseCommit ?? `${requestedCommit}^`;
let baseCommitOid: string | null = null;
try {
  baseCommitOid = await resolveCommit(requestedBaseCommit);
} catch (error) {
  if (explicitBaseCommit) throw error;
}
if (baseCommitOid === commitOid) baseCommitOid = null;
const benchmarkIterations = integerArgument("iterations", 30);
const warmups = integerArgument("warmups", 5);
const concurrency = integerArgument("concurrency", 1);
const dependencySymbol = stringArgument("dependency-symbol", "createMemoryModule");
const outputPath = optionalStringArgument("output");
const queries = repeatedArguments("query");
if (queries.length === 0) {
  queries.push(
    "createMemoryModule",
    "workspace_id",
    "Memory Proposal",
    "=>",
    "loreDefinitelyAbsentCodeSearchMarker",
  );
}

const parsedUrl = new URL(databaseUrl);
const expectedDatabaseName = decodeURIComponent(parsedUrl.pathname.slice(1));
if (!/(^|[_-])bench(mark)?([_-]|$)/i.test(expectedDatabaseName)) {
  throw new Error(
    `Refusing to modify non-benchmark database ${JSON.stringify(expectedDatabaseName)}`,
  );
}

const visibleUserId = "10000000-0000-4000-8000-000000000091";
const forbiddenUserId = "10000000-0000-4000-8000-000000000092";
const visibleWorkspaceId = "20000000-0000-4000-8000-000000000091";
const forbiddenWorkspaceId = "20000000-0000-4000-8000-000000000092";
const visibleActor: ActorContext = { userId: visibleUserId, workspaceId: visibleWorkspaceId };
const forbiddenActor: ActorContext = {
  userId: forbiddenUserId,
  workspaceId: forbiddenWorkspaceId,
};
const repositoryKey = "benchmark/source-repository";

const admin = new Client({ connectionString: databaseUrl });
const database = createPostgresDatabase(
  { connectionString: databaseUrl, max: Math.max(4, concurrency + 1) },
  { role: "lore_app" },
);
await admin.connect();
try {
  const databaseState = await admin.query<{
    database_name: string;
    code_artifacts: string | null;
    code_artifact_payloads: string | null;
    code_dependency_payloads: string | null;
    code_dependency_sets: string | null;
    code_symbol_sets: string | null;
    manifest: string | null;
    trigram_index: string | null;
  }>(`SELECT
       current_database() AS database_name,
       to_regclass('public.code_artifacts')::text AS code_artifacts,
       to_regclass('public.code_artifact_payloads')::text AS code_artifact_payloads,
       to_regclass('public.code_symbol_sets')::text AS code_symbol_sets,
       to_regclass('public.code_dependency_sets')::text AS code_dependency_sets,
       to_regclass('public.code_dependency_payloads')::text AS code_dependency_payloads,
       to_regclass('public.code_revision_files')::text AS manifest,
       to_regclass('public.code_artifact_payloads_content_trgm_idx')::text AS trigram_index`);
  const state = databaseState.rows[0];
  if (
    state?.database_name !== expectedDatabaseName ||
    !state.code_artifacts ||
    !state.code_artifact_payloads ||
    !state.code_symbol_sets ||
    !state.code_dependency_sets ||
    !state.code_dependency_payloads ||
    !state.manifest ||
    !state.trigram_index
  ) {
    throw new Error("The target must contain the current migrated Lore Code Index schema");
  }

  async function storageSnapshot() {
    const snapshot = await admin.query<{
      artifact_payloads: number;
      artifacts: number;
      code_relation_bytes: string;
      database_bytes: string;
      dependency_edges: number;
      dependency_payloads: number;
      dependency_sets: number;
      manifest_entries: number;
      symbol_payloads: number;
      symbol_sets: number;
    }>(`SELECT
         (SELECT count(*)::integer FROM code_artifacts) AS artifacts,
         (SELECT count(*)::integer FROM code_artifact_payloads) AS artifact_payloads,
         (SELECT count(*)::integer FROM code_symbol_sets) AS symbol_sets,
         (SELECT count(*)::integer FROM code_symbol_payloads) AS symbol_payloads,
         (SELECT count(*)::integer FROM code_dependency_sets) AS dependency_sets,
         (SELECT count(*)::integer FROM code_dependency_payloads) AS dependency_payloads,
         (SELECT count(*)::integer FROM code_dependency_edges) AS dependency_edges,
         (SELECT count(*)::integer FROM code_revision_files) AS manifest_entries,
         pg_database_size(current_database())::text AS database_bytes,
         (
           pg_total_relation_size('code_repositories')
           + pg_total_relation_size('code_revisions')
           + pg_total_relation_size('code_revision_files')
           + pg_total_relation_size('code_index_generations')
           + pg_total_relation_size('code_artifact_payloads')
           + pg_total_relation_size('code_symbol_sets')
           + pg_total_relation_size('code_symbol_payloads')
           + pg_total_relation_size('code_artifacts')
           + pg_total_relation_size('code_dependency_sets')
           + pg_total_relation_size('code_dependency_payloads')
           + pg_total_relation_size('code_dependency_edges')
         )::text AS code_relation_bytes`);
    const row = snapshot.rows[0];
    if (!row) throw new Error("Code Index storage snapshot returned no row");
    return {
      artifacts: row.artifacts,
      artifactPayloads: row.artifact_payloads,
      symbolSets: row.symbol_sets,
      symbolPayloads: row.symbol_payloads,
      dependencySets: row.dependency_sets,
      dependencyPayloads: row.dependency_payloads,
      dependencyEdges: row.dependency_edges,
      manifestEntries: row.manifest_entries,
      databaseBytes: Number(row.database_bytes),
      codeRelationBytes: Number(row.code_relation_bytes),
    };
  }

  await admin.query("BEGIN");
  try {
    await admin.query("TRUNCATE users, workspaces CASCADE");
    await admin.query(
      `INSERT INTO users (id, display_name)
       VALUES ($1, 'Benchmark Visible'), ($2, 'Benchmark Forbidden')`,
      [visibleUserId, forbiddenUserId],
    );
    await admin.query(
      `INSERT INTO workspaces (id, name)
       VALUES ($1, 'Code Index Visible'), ($2, 'Code Index Forbidden')`,
      [visibleWorkspaceId, forbiddenWorkspaceId],
    );
    await admin.query(
      `INSERT INTO memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
      [visibleWorkspaceId, visibleUserId, forbiddenWorkspaceId, forbiddenUserId],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }

  const storageBeforeIndex = await storageSnapshot();
  const code = createCodeIndexModule(database);
  const graph = createCodeDependencyGraphModule(database);
  const fullCommitOid = baseCommitOid ?? commitOid;
  const fullSourceRef = baseCommitOid ? requestedBaseCommit : requestedCommit;
  const fullPhase = await measurePhase(() =>
    code.indexGitRevision(visibleActor, {
      repositoryKey,
      displayName: "Source repository benchmark",
      repositoryPath,
      commitOid: fullCommitOid,
      sourceRef: fullSourceRef,
    }),
  );
  const full = fullPhase.result;
  const storageAfterFull = await storageSnapshot();
  if (full.parsedFileCount !== full.manifest.indexedFileCount || full.reusedFileCount !== 0) {
    throw new Error("Fresh full index unexpectedly reused or omitted indexed Git blobs");
  }
  let incremental: Awaited<ReturnType<typeof code.indexGitRevision>> | null = null;
  let incrementalMetrics: PhaseMetrics | null = null;
  let storageAfterIncremental = storageAfterFull;
  if (baseCommitOid) {
    const incrementalPhase = await measurePhase(() =>
      code.indexGitRevision(visibleActor, {
        repositoryKey,
        displayName: "Source repository benchmark",
        repositoryPath,
        commitOid,
        sourceRef: requestedCommit,
      }),
    );
    incremental = incrementalPhase.result;
    incrementalMetrics = incrementalPhase.metrics;
    storageAfterIncremental = await storageSnapshot();
    if (
      incremental.parsedFileCount + incremental.reusedFileCount !==
      incremental.manifest.indexedFileCount
    ) {
      throw new Error("Incremental index did not account for every indexed Git blob");
    }
  }
  const target = incremental ?? full;
  const noOpPhase = await measurePhase(() =>
    code.indexGitRevision(visibleActor, {
      repositoryKey,
      displayName: "Source repository benchmark",
      repositoryPath,
      commitOid,
      sourceRef: requestedCommit,
    }),
  );
  const noOp = noOpPhase.result;
  const storageAfterNoOp = await storageSnapshot();
  if (
    !noOp.reused ||
    noOp.parsedFileCount !== 0 ||
    noOp.reusedFileCount !== noOp.manifest.indexedFileCount
  ) {
    throw new Error("No-op replay did not reuse the completed Code Index generation and blobs");
  }

  await code.indexRevision(forbiddenActor, {
    repositoryKey,
    displayName: "Forbidden tripwire",
    commitOid,
    files: [
      {
        path: "forbidden/high-score-tripwire.ts",
        content: queries.map((query) => `${query} ${query} ${query}`).join("\n"),
      },
    ],
  });
  const analyzeStartedAt = performance.now();
  await admin.query("VACUUM (ANALYZE) code_artifacts");
  await admin.query("VACUUM (ANALYZE) code_symbol_sets");
  await admin.query("VACUUM (ANALYZE) code_symbol_payloads");
  await admin.query("VACUUM (ANALYZE) code_dependency_sets");
  await admin.query("VACUUM (ANALYZE) code_dependency_payloads");
  await admin.query("VACUUM (ANALYZE) code_dependency_edges");
  const analyzeMs = performance.now() - analyzeStartedAt;

  const queryResults: Array<Record<string, unknown>> = [];
  async function measureQuery(query: string): Promise<Record<string, unknown>> {
    await Promise.all(
      Array.from({ length: warmups * concurrency }, () =>
        code.search(visibleActor, { repositoryKey, commitOid, query, limit: 10 }),
      ),
    );
    const samples: number[] = [];
    let topPaths: string[] = [];
    let resultCount = 0;
    for (const _iteration of Array.from({ length: benchmarkIterations })) {
      const results = await Promise.all(
        Array.from({ length: concurrency }, async () => {
          const startedAt = performance.now();
          const found = await code.search(visibleActor, {
            repositoryKey,
            commitOid,
            query,
            limit: 10,
          });
          samples.push(performance.now() - startedAt);
          return found;
        }),
      );
      const representative = results[0] ?? [];
      resultCount = representative.length;
      topPaths = representative.slice(0, 3).map((result) => result.path);
      if (representative.some((result) => result.path.startsWith("forbidden/"))) {
        throw new Error(`RLS tripwire leaked for query ${JSON.stringify(query)}`);
      }
    }
    const expectedSampleCount = benchmarkIterations * concurrency;
    if (samples.length !== expectedSampleCount) {
      throw new Error(
        `Query ${JSON.stringify(query)} recorded ${samples.length}/${expectedSampleCount} samples`,
      );
    }
    return { query, resultCount, topPaths, ...distribution(samples) };
  }
  for (const query of queries) {
    queryResults.push(await measureQuery(query));
  }

  async function measureDependencies(direction: "callers" | "callees") {
    for (let index = 0; index < warmups; index += 1) {
      await graph.query(visibleActor, {
        repositoryKey,
        commitOid,
        direction,
        symbol: dependencySymbol,
        limit: 200,
      });
    }
    const samples: number[] = [];
    let representative: Awaited<ReturnType<typeof graph.query>> | null = null;
    for (let index = 0; index < benchmarkIterations; index += 1) {
      const startedAt = performance.now();
      representative = await graph.query(visibleActor, {
        repositoryKey,
        commitOid,
        direction,
        symbol: dependencySymbol,
        limit: 200,
      });
      samples.push(performance.now() - startedAt);
    }
    return {
      direction,
      symbol: dependencySymbol,
      status: representative?.status ?? "not_measured",
      resultCount:
        representative?.status === "ok"
          ? representative.edges.length
          : representative?.status === "ambiguous"
            ? representative.candidates.length
            : 0,
      truncated:
        representative?.status === "ok" || representative?.status === "ambiguous"
          ? representative.truncated
          : false,
      ...distribution(samples),
    };
  }
  const dependencyResults = [
    await measureDependencies("callers"),
    await measureDependencies("callees"),
  ];

  let contextualResult: Record<string, unknown> | null = null;
  if (baseCommitOid) {
    const baseCandidates = await code.search(visibleActor, {
      repositoryKey,
      commitOid: baseCommitOid,
      query: dependencySymbol,
      limit: 100,
    });
    const citedArtifact = baseCandidates.find(
      (candidate) =>
        candidate.symbol === dependencySymbol ||
        candidate.symbols.some((symbol) => symbol.symbol === dependencySymbol),
    );
    if (!citedArtifact) {
      throw new Error(
        `--dependency-symbol ${JSON.stringify(dependencySymbol)} was not an exact base-revision symbol`,
      );
    }
    const memories = createMemoryModule(database);
    const evidence = createCodeEvidenceModule(database);
    const context = createContextRetrievalModule(database);
    const benchmarkMemory = await memories.remember(visibleActor, {
      content: `Historical benchmark rationale for ${dependencySymbol} and its implementation dependencies.`,
      metadata: { benchmark: "code-context-v1" },
    });
    const citation = await evidence.cite(visibleActor, {
      memoryId: benchmarkMemory.id,
      artifactId: citedArtifact.id,
      relationship: "rationale",
    });
    const contextInput = {
      query: `What changed about ${dependencySymbol}?`,
      memoryQuery: dependencySymbol,
      codeQuery: dependencySymbol,
      repositoryKey,
      commitOid,
      memoryLimit: 5,
      codeLimit: 10,
    } as const;
    for (let index = 0; index < warmups; index += 1) {
      await context.retrieve(visibleActor, contextInput);
    }
    const samples: number[] = [];
    let representative: Awaited<ReturnType<typeof context.retrieve>> | null = null;
    for (let index = 0; index < benchmarkIterations; index += 1) {
      const startedAt = performance.now();
      representative = await context.retrieve(visibleActor, contextInput);
      samples.push(performance.now() - startedAt);
    }
    if (!representative?.receipt.contextualImpact) {
      throw new Error("Context benchmark did not produce a contextual impact assessment");
    }
    if (!representative.anchors.some((anchor) => anchor.id === citation.id)) {
      throw new Error("Context benchmark did not retrieve the exact Memory Code Evidence anchor");
    }
    contextualResult = {
      symbol: dependencySymbol,
      route: representative.deliveredRoute,
      localStates: [...new Set(representative.anchors.map((anchor) => anchor.localState))],
      contextualState: representative.receipt.contextualImpact.state,
      changeCount: representative.receipt.contextualImpact.changes.length,
      changes: representative.receipt.contextualImpact.changes,
      memoryCandidates: representative.receipt.memoryCandidates,
      codeCandidates: representative.receipt.codeCandidates,
      anchorCandidates: representative.receipt.anchorCandidates,
      ...distribution(samples),
    };
  }

  await admin.query(
    `UPDATE memberships SET status = 'suspended'
     WHERE workspace_id = $1 AND user_id = $2`,
    [visibleWorkspaceId, visibleUserId],
  );
  const revokedResults = await code.search(visibleActor, {
    repositoryKey,
    commitOid,
    query: queries[0] ?? "workspace_id",
  });
  if (revokedResults.length !== 0)
    throw new Error("Suspended Membership retained Code Index access");
  const revokedDependencies = await graph.query(visibleActor, {
    repositoryKey,
    commitOid,
    direction: "callees",
    symbol: dependencySymbol,
  });
  if (revokedDependencies.status !== "not_found") {
    throw new Error("Suspended Membership retained Code Dependency access");
  }

  const storage = await admin.query<{
    artifacts: number;
    artifact_payloads: number;
    dependency_edges: number;
    dependency_payloads: number;
    dependency_sets: number;
    manifest_entries: number;
    symbol_payloads: number;
    symbol_sets: number;
    artifact_table_bytes: string;
    artifact_indexes_bytes: string;
    payload_table_bytes: string;
    payload_indexes_bytes: string;
    symbol_relation_bytes: string;
    dependency_relation_bytes: string;
  }>(`SELECT
       (SELECT count(*)::integer FROM code_artifacts) AS artifacts,
       (SELECT count(*)::integer FROM code_artifact_payloads) AS artifact_payloads,
       (SELECT count(*)::integer FROM code_symbol_sets) AS symbol_sets,
       (SELECT count(*)::integer FROM code_symbol_payloads) AS symbol_payloads,
       (SELECT count(*)::integer FROM code_dependency_sets) AS dependency_sets,
       (SELECT count(*)::integer FROM code_dependency_payloads) AS dependency_payloads,
       (SELECT count(*)::integer FROM code_dependency_edges) AS dependency_edges,
       (SELECT count(*)::integer FROM code_revision_files) AS manifest_entries,
       pg_total_relation_size('public.code_artifacts')::text AS artifact_table_bytes,
       pg_indexes_size('public.code_artifacts')::text AS artifact_indexes_bytes,
       pg_total_relation_size('public.code_artifact_payloads')::text AS payload_table_bytes,
       pg_indexes_size('public.code_artifact_payloads')::text AS payload_indexes_bytes,
       (pg_total_relation_size('public.code_symbol_sets')
         + pg_total_relation_size('public.code_symbol_payloads'))::text
         AS symbol_relation_bytes,
       (pg_total_relation_size('public.code_dependency_sets')
         + pg_total_relation_size('public.code_dependency_payloads')
         + pg_total_relation_size('public.code_dependency_edges'))::text
         AS dependency_relation_bytes`);

  const report = {
    revision: BENCHMARK_REVISION,
    environment: {
      database: expectedDatabaseName,
      postgresVersion: (await admin.query("SHOW server_version")).rows[0]?.server_version,
      runtime: `Bun ${process.versions.bun ?? "unknown"}`,
      host: {
        platform: platform(),
        release: release(),
        architecture: arch(),
        logicalCpuCount: cpus().length,
        cpuModel: cpus()[0]?.model ?? "unknown",
        totalMemoryBytes: totalmem(),
      },
      cache: {
        indexing: "fresh Lore tenant rows; operating-system and PostgreSQL caches unspecified",
        retrieval: "warm",
      },
      concurrency,
      iterations: benchmarkIterations,
      warmups,
    },
    source: {
      repositoryPath,
      requestedBaseCommit: baseCommitOid ? requestedBaseCommit : null,
      baseCommitOid,
      requestedCommit,
      commitOid,
    },
    indexing: {
      full: {
        ...fullPhase.metrics,
        commitOid: fullCommitOid,
        indexedFiles: full.manifest.indexedFileCount,
        excludedFiles: full.manifest.excludedFileCount,
        manifestEntries: full.manifest.totalEntryCount,
        artifacts: full.artifactCount,
        parsedFiles: full.parsedFileCount,
        reusedFiles: full.reusedFileCount,
      },
      incremental:
        incremental && incrementalMetrics
          ? {
              ...incrementalMetrics,
              commitOid,
              indexedFiles: incremental.manifest.indexedFileCount,
              excludedFiles: incremental.manifest.excludedFileCount,
              manifestEntries: incremental.manifest.totalEntryCount,
              artifacts: incremental.artifactCount,
              parsedFiles: incremental.parsedFileCount,
              reusedFiles: incremental.reusedFileCount,
            }
          : null,
      noOp: {
        ...noOpPhase.metrics,
        artifacts: noOp.artifactCount,
        parsedFiles: noOp.parsedFileCount,
        reusedFiles: noOp.reusedFileCount,
        reusedGeneration: noOp.reused,
      },
      analyzeMs: Number(analyzeMs.toFixed(1)),
      targetArtifacts: target.artifactCount,
    },
    storage: {
      beforeIndex: storageBeforeIndex,
      afterFull: {
        ...storageAfterFull,
        databaseBytesDelta: storageAfterFull.databaseBytes - storageBeforeIndex.databaseBytes,
        codeRelationBytesDelta:
          storageAfterFull.codeRelationBytes - storageBeforeIndex.codeRelationBytes,
      },
      afterIncremental: {
        ...storageAfterIncremental,
        databaseBytesDelta: storageAfterIncremental.databaseBytes - storageAfterFull.databaseBytes,
        codeRelationBytesDelta:
          storageAfterIncremental.codeRelationBytes - storageAfterFull.codeRelationBytes,
      },
      afterNoOp: {
        ...storageAfterNoOp,
        databaseBytesDelta: storageAfterNoOp.databaseBytes - storageAfterIncremental.databaseBytes,
        codeRelationBytesDelta:
          storageAfterNoOp.codeRelationBytes - storageAfterIncremental.codeRelationBytes,
      },
      final: storage.rows[0],
    },
    search: queryResults,
    dependencies: dependencyResults,
    contextualTraversal: contextualResult,
    isolation: { forbiddenWorkspaceTripwire: "passed", suspendedMembership: "passed" },
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  if (outputPath) {
    const absoluteOutputPath = resolve(outputPath);
    await mkdir(dirname(absoluteOutputPath), { recursive: true });
    await writeFile(absoluteOutputPath, serialized, "utf8");
  }
} finally {
  await database.close();
  await admin.end();
}
