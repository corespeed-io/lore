/**
 * Reproducible SQL microbenchmark for Code Index query strategies.
 * It owns and rebuilds only the code_search_benchmark schema in a database whose
 * name contains "benchmark".
 */
import { Client } from "pg";

const databaseUrl = process.env.CODE_SEARCH_BENCHMARK_DATABASE_URL;
if (!databaseUrl) throw new Error("CODE_SEARCH_BENCHMARK_DATABASE_URL is required");
const parsedUrl = new URL(databaseUrl);
const databaseName = parsedUrl.pathname.slice(1);
if (!/(^|_)bench(mark)?($|_)/i.test(databaseName)) {
  throw new Error(`Refusing to modify non-benchmark database ${JSON.stringify(databaseName)}`);
}

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

const visibleArtifacts = integerArgument("artifacts", 100_000);
const iterations = integerArgument("iterations", 50);
const warmups = integerArgument("warmups", 10);
const query = stringArgument("query", "fetch<User>");
const literalPattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
const client = new Client({ connectionString: databaseUrl });

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function measure(
  name: string,
  text: string,
  parameters: string[] = [query],
): Promise<Record<string, unknown>> {
  for (let index = 0; index < warmups; index += 1) await client.query(text, parameters);
  const samples: number[] = [];
  let resultRows = 0;
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const result = await client.query(text, parameters);
    samples.push(performance.now() - startedAt);
    resultRows = result.rows.length;
  }
  samples.sort((left, right) => left - right);
  const explained = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,
    parameters,
  );
  const explain = explained.rows[0]?.["QUERY PLAN"]?.[0];
  return {
    name,
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    p99Ms: Number(percentile(samples, 0.99).toFixed(3)),
    planExecutionMs: explain?.["Execution Time"],
    plan: explain?.Plan,
    resultRows,
  };
}

await client.connect();
try {
  await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  await client.query("DROP SCHEMA IF EXISTS code_search_benchmark CASCADE");
  await client.query("CREATE SCHEMA code_search_benchmark");
  await client.query(`
    CREATE TABLE code_search_benchmark.artifacts (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id integer NOT NULL,
      repository_id integer NOT NULL,
      revision_id integer NOT NULL,
      generation_id integer NOT NULL,
      path text NOT NULL,
      ordinal integer NOT NULL,
      symbol text,
      content text NOT NULL,
      search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', path || ' ' || coalesce(symbol, '') || ' ' || content)
      ) STORED
    )
  `);
  const loadStartedAt = performance.now();
  await client.query(
    `INSERT INTO code_search_benchmark.artifacts (
       workspace_id, repository_id, revision_id, generation_id,
       path, ordinal, symbol, content
     )
     SELECT
       scope, 1, 1, 1,
       'src/generated/file-' || series || '.ts',
       series,
       CASE WHEN series % 211 = 0 THEN 'fetchUser' ELSE 'symbol' || series END,
       CASE
         WHEN series = $1 THEN
           'export const exact = client.fetch<User>(id); '
           || 'const mapped = (input) => input?.profile; foo.bar(input); value::text; '
           || repeat('x', 350)
         WHEN series % 100 = 0 THEN
           'export const distractor = fetch + User; ' || repeat('x', 420)
         ELSE
           'export const value' || series || ' = normalize(memoryArtifact' || series || '); '
           || repeat('x', 400)
       END
     FROM generate_series(1, $1) series
     CROSS JOIN generate_series(1, 2) scope`,
    [visibleArtifacts],
  );
  const loadMs = performance.now() - loadStartedAt;

  const indexStartedAt = performance.now();
  await client.query(`
    CREATE INDEX artifacts_scope_idx
    ON code_search_benchmark.artifacts
      (workspace_id, repository_id, revision_id, generation_id, path, ordinal)
  `);
  await client.query(`
    CREATE INDEX artifacts_fts_idx
    ON code_search_benchmark.artifacts USING gin (search_vector)
  `);
  await client.query(`
    CREATE INDEX artifacts_content_trgm_idx
    ON code_search_benchmark.artifacts USING gin (lower(content) gin_trgm_ops)
  `);
  await client.query("ANALYZE code_search_benchmark.artifacts");
  const indexMs = performance.now() - indexStartedAt;

  const scope = `workspace_id = 1 AND repository_id = 1 AND revision_id = 1 AND generation_id = 1`;
  const strategies = [
    await measure(
      "fts_only",
      `SELECT id, path
       FROM code_search_benchmark.artifacts
       WHERE ${scope}
         AND search_vector @@ websearch_to_tsquery('simple', $1)
       ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('simple', $1), 32) DESC, id
       LIMIT 10`,
    ),
    await measure(
      "literal_position_scan",
      `SELECT id, path
       FROM code_search_benchmark.artifacts
       WHERE ${scope}
         AND position(lower($1) in lower(content)) > 0
       ORDER BY id
       LIMIT 10`,
    ),
    await measure(
      "literal_pg_trgm",
      `SELECT id, path
       FROM code_search_benchmark.artifacts
       WHERE ${scope}
         AND lower(content) LIKE lower($1) ESCAPE chr(92)
       ORDER BY id
       LIMIT 10`,
      [literalPattern],
    ),
    await measure(
      "current_combined_or",
      `SELECT id, path,
         (
           CASE WHEN position(lower($1) in lower(content)) > 0 THEN 3.0 ELSE 0.0 END
           + ts_rank_cd(search_vector, websearch_to_tsquery('simple', $1), 32)
         ) AS score
       FROM code_search_benchmark.artifacts
       WHERE ${scope}
         AND (
           search_vector @@ websearch_to_tsquery('simple', $1)
           OR position(lower($1) in lower(content)) > 0
         )
       ORDER BY score DESC, id
       LIMIT 10`,
    ),
    await measure(
      "indexed_combined_or",
      `SELECT id, path,
         (
           CASE WHEN lower(content) LIKE lower($2) ESCAPE chr(92) THEN 3.0 ELSE 0.0 END
           + ts_rank_cd(search_vector, websearch_to_tsquery('simple', $1), 32)
         ) AS score
       FROM code_search_benchmark.artifacts
       WHERE ${scope}
         AND (
           search_vector @@ websearch_to_tsquery('simple', $1)
           OR lower(content) LIKE lower($2) ESCAPE chr(92)
         )
       ORDER BY score DESC, id
       LIMIT 10`,
      [query, literalPattern],
    ),
  ];

  console.log(
    JSON.stringify(
      {
        database: {
          name: databaseName,
          postgresVersion: (await client.query("SHOW server_version")).rows[0]?.server_version,
        },
        dataset: { totalArtifacts: visibleArtifacts * 2, visibleArtifacts },
        iterations,
        query,
        loadMs: Number(loadMs.toFixed(1)),
        indexMs: Number(indexMs.toFixed(1)),
        strategies,
        warmups,
      },
      null,
      2,
    ),
  );
} finally {
  await client.end();
}
