/**
 * Measure Memory search latency and plans on a disposable benchmark database.
 *
 * BENCHMARK_DATABASE_URL must name a database whose name contains `bench`, with
 * the Lore migrations applied and search-latency-corpus.sql loaded. The login must be able to
 * `SET ROLE lore_app`. Every query runs as lore_app under the Actor's RLS
 * context, as a request would. Embeddings are random unit vectors from a fixed
 * seed: they measure the cost of the semantic channel, not its quality.
 */
import {
  createMemoryModule,
  type EmbeddingProvider,
  type PostgresTransaction,
} from "@corespeed/lore-core";
import { createEpisodeEvidenceModule } from "@corespeed/lore-core/episodes";
import {
  compareSemanticCandidates,
  type SemanticCandidateQuery,
} from "@corespeed/lore-core/testing";
import { createPostgresDatabase } from "../../../src/server/database/postgres";

const databaseUrl = process.env.BENCHMARK_DATABASE_URL;
if (!databaseUrl) throw new Error("BENCHMARK_DATABASE_URL is required");
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/(^|_)bench(mark)?($|_)/i.test(databaseName)) {
  throw new Error(`Refusing to measure non-benchmark database ${JSON.stringify(databaseName)}`);
}

const workspaceId = process.env.BENCHMARK_WORKSPACE_ID ?? "00000000-0000-4000-8000-000000000001";
const userId = process.env.BENCHMARK_USER_ID ?? "00000000-0000-4000-8000-0000000000a1";
const runs = Number(process.env.BENCHMARK_RUNS ?? 5);
const explain = process.env.BENCHMARK_EXPLAIN === "1";
const verify = process.env.BENCHMARK_VERIFY === "1";
const dimensions = 1024;

let seed = 1;
function random(): number {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
}

const embeddingProvider: EmbeddingProvider = {
  provider: process.env.BENCHMARK_EMBEDDING_PROVIDER ?? "perf",
  model: process.env.BENCHMARK_EMBEDDING_MODEL ?? "perf-model",
  revision: process.env.BENCHMARK_EMBEDDING_REVISION ?? "r1",
  dimensions,
  async embed(texts) {
    return texts.map(() => Array.from({ length: dimensions }, () => random() - 0.5));
  },
};

const database = createPostgresDatabase({ connectionString: databaseUrl, max: 2 });
const captured: { sql: string; params: readonly unknown[] }[] = [];

function withActor(transaction: PostgresTransaction): PostgresTransaction {
  transaction.setLocal({
    "lore.workspace_id": workspaceId,
    "lore.user_id": userId,
    "lore.agent_id": "",
  });
  return {
    ...transaction,
    query: (sql, params) => transaction.query(sql, params),
    batch: (statements, options) => {
      for (const item of statements) captured.push({ sql: item.sql, params: item.params });
      return transaction.batch(statements, options);
    },
    setLocal: (settings) => transaction.setLocal(settings),
    afterCommit: (effect) => transaction.afterCommit(effect),
  };
}

const storage = {
  partitionId: workspaceId,
  ownerId: userId,
  database: {
    transaction: <Result>(
      use: (transaction: PostgresTransaction) => Promise<Result>,
      options?: Parameters<typeof database.transaction>[1],
    ) => database.transaction((transaction) => use(withActor(transaction)), options),
  },
};

const lexical = createMemoryModule(storage, { embeddingDimensions: dimensions });
const hybrid = createMemoryModule(storage, { embeddingDimensions: dimensions, embeddingProvider });

async function vocabulary(): Promise<{ common: string[]; rare: string[] }> {
  return database.transaction(async (raw) => {
    const transaction = withActor(raw);
    const result = await transaction.query<{ word: string; documents: number }>(
      `SELECT word, ndoc AS documents
       FROM ts_stat($$SELECT search_vector FROM memory_chunks
                      WHERE workspace_id = '${workspaceId}'$$)
       ORDER BY ndoc DESC`,
    );
    const words = result.rows.filter((row) => /^[a-z0-9]+$/.test(row.word));
    return {
      common: words.slice(0, 4).map((row) => row.word),
      rare: words.slice(-200, -196).map((row) => row.word),
    };
  });
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? Number.NaN;
}

const words = await vocabulary();
const queries = [
  { name: "rare words", text: words.rare.join(" ") },
  { name: "common words", text: words.common.join(" ") },
  { name: "mixed", text: `${words.common[0]} ${words.rare[0]} ${words.rare[1]}` },
  { name: "cjk", text: "数据库性能优化" },
];

const report: Record<string, string>[] = [];
for (const query of queries) {
  for (const [mode, module] of [
    ["lexical", lexical],
    ["hybrid", hybrid],
  ] as const) {
    const timings: number[] = [];
    let results = 0;
    for (let run = 0; run < runs + 1; run += 1) {
      captured.length = 0;
      const started = performance.now();
      const found = await module.search({ query: query.text, limit: 10 });
      const elapsed = performance.now() - started;
      // The first run warms the cache and the plan; it is not counted.
      if (run > 0) timings.push(elapsed);
      results = found.length;
    }
    report.push({
      query: query.name,
      mode,
      results: String(results),
      p50: percentile(timings, 0.5).toFixed(1),
      max: Math.max(...timings).toFixed(1),
    });
    if (explain && mode === "hybrid") {
      const search = captured.find((item) => item.sql.includes("lexical_candidates"));
      if (search) {
        const plan = await database.transaction(async (transaction) => {
          withActor(transaction);
          const result = await transaction.query<{ "QUERY PLAN": string }>(
            `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON) ${search.sql}`,
            [...search.params],
          );
          return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
        });
        console.log(`\n=== ${query.name} (hybrid) plan ===\n${plan}`);
      }
    }
  }
}

// Episode evidence search, when the corpus has Episodes.
const evidence = {
  lexical: createEpisodeEvidenceModule(storage, { embeddingDimensions: dimensions }),
  hybrid: createEpisodeEvidenceModule(storage, {
    embeddingDimensions: dimensions,
    embeddingProvider,
  }),
};
for (const query of [
  { name: "evidence: observation words", text: "observation 7" },
  { name: "evidence: no match", text: "nothing matches this" },
]) {
  for (const mode of ["lexical", "hybrid"] as const) {
    const timings: number[] = [];
    let results = 0;
    for (let run = 0; run < runs + 1; run += 1) {
      const started = performance.now();
      const found = await evidence[mode].search({ query: query.text, limit: 10 });
      if (run > 0) timings.push(performance.now() - started);
      results = found.length;
    }
    report.push({
      query: query.name,
      mode,
      results: String(results),
      p50: percentile(timings, 0.5).toFixed(1),
      max: Math.max(...timings).toFixed(1),
    });
  }
}

console.table(report);

if (verify) {
  // lore.semantic_candidates must answer exactly what the RLS reference answers.
  const queries: SemanticCandidateQuery[] = [];
  for (const distanceThreshold of [0.9, 1, 1.05]) {
    for (const filters of [
      {},
      { scope: "private" as const },
      { updatedAfter: new Date(Date.now() - 7 * 86_400_000).toISOString() },
    ]) {
      const [queryEmbedding = []] = await embeddingProvider.embed(["verify"], "query");
      queries.push({
        queryEmbedding,
        embeddingProvider,
        embeddingDimensions: dimensions,
        distanceThreshold,
        candidateLimit: 120,
        ...filters,
      });
    }
  }
  let compared = 0;
  for (const { query, host, reference } of await compareSemanticCandidates(storage, queries)) {
    if (JSON.stringify(host) !== JSON.stringify(reference)) {
      const { queryEmbedding: _vector, ...shown } = query;
      throw new Error(`Semantic candidates differ from the reference for ${JSON.stringify(shown)}`);
    }
    compared += reference.length;
  }
  console.log(
    `Semantic candidates match the reference: ${queries.length} queries, ${compared} rows`,
  );
}
await database.close();
