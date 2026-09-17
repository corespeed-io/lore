import pg from "pg";

const databaseUrl = process.env.BENCHMARK_DATABASE_URL;
if (!databaseUrl) throw new Error("BENCHMARK_DATABASE_URL is required");

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const nodeCount = positiveInteger("BENCHMARK_NODE_COUNT", 5_000);
const localOffsetCount = positiveInteger("BENCHMARK_LOCAL_OFFSETS", 18);
const longOffsets = [137, 997, 1_999].filter((offset) => offset < nodeCount / 2);
const offsets = [
  ...Array.from(
    { length: Math.min(localOffsetCount, Math.floor((nodeCount - 1) / 2)) },
    (_, i) => i + 1,
  ),
  ...longOffsets,
].filter((offset, index, all) => all.indexOf(offset) === index);

if (offsets.length === 0) {
  throw new Error("The benchmark needs at least two nodes to create links");
}

const expectedLinkCount = nodeCount * offsets.length;
const datasetId = "00000000-0000-4000-8000-000000005000";
const client = new pg.Client({ connectionString: databaseUrl });
const startedAt = performance.now();

await client.connect();
try {
  const databaseResult = await client.query("SELECT current_database() AS name");
  const databaseName = databaseResult.rows[0]?.name ?? "";
  if (!/(^|_)bench(mark)?($|_)/i.test(databaseName)) {
    throw new Error(
      `Refusing to rebuild graph_benchmark in non-benchmark database ${JSON.stringify(databaseName)}`,
    );
  }

  await client.query("BEGIN");
  try {
    await client.query("DROP SCHEMA IF EXISTS graph_benchmark CASCADE");
    await client.query("CREATE SCHEMA graph_benchmark");
    await client.query(`
      CREATE TABLE graph_benchmark.datasets (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        node_count integer NOT NULL CHECK (node_count > 0),
        link_count integer NOT NULL CHECK (link_count > 0),
        generated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE graph_benchmark.nodes (
        dataset_id uuid NOT NULL REFERENCES graph_benchmark.datasets(id) ON DELETE CASCADE,
        id bigint NOT NULL,
        label text NOT NULL,
        preview text NOT NULL,
        type text NOT NULL,
        scope text NOT NULL CHECK (scope IN ('shared', 'private')),
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (dataset_id, id)
      )
    `);
    await client.query(`
      CREATE TABLE graph_benchmark.links (
        dataset_id uuid NOT NULL REFERENCES graph_benchmark.datasets(id) ON DELETE CASCADE,
        source bigint NOT NULL,
        target bigint NOT NULL,
        kind text NOT NULL DEFAULT 'affinity' CHECK (kind = 'affinity'),
        weight real NOT NULL CHECK (weight >= 0 AND weight <= 1),
        CHECK (source < target),
        PRIMARY KEY (dataset_id, source, target),
        FOREIGN KEY (dataset_id, source)
          REFERENCES graph_benchmark.nodes(dataset_id, id) ON DELETE CASCADE,
        FOREIGN KEY (dataset_id, target)
          REFERENCES graph_benchmark.nodes(dataset_id, id) ON DELETE CASCADE
      )
    `);

    await client.query(
      `INSERT INTO graph_benchmark.datasets (id, name, node_count, link_count)
       VALUES ($1, 'Lore renderer stress graph', $2, $3)`,
      [datasetId, nodeCount, expectedLinkCount],
    );
    await client.query(
      `INSERT INTO graph_benchmark.nodes (
         dataset_id, id, label, preview, type, scope, updated_at
       )
       SELECT
         $1,
         node_id,
         format('Benchmark Memory %s', lpad(node_id::text, 5, '0')),
         format(
           'Synthetic Memory %s in cluster %s for deterministic Lore graph rendering benchmarks.',
           node_id,
           node_id % 50
         ),
         (ARRAY['person', 'company', 'product', 'project', 'event', 'concept', 'decision', 'other'])[
           1 + (node_id % 8)
         ],
         CASE WHEN node_id % 10 = 0 THEN 'private' ELSE 'shared' END,
         timestamptz '2026-01-01 00:00:00+00' + node_id * interval '1 minute'
       FROM generate_series(0, $2 - 1) AS node_id`,
      [datasetId, nodeCount],
    );
    await client.query(
      `WITH raw_links AS (
         SELECT
           node_id,
           (node_id + link_offset) % $2 AS neighbor_id
         FROM generate_series(0, $2 - 1) AS node_id
         CROSS JOIN unnest($3::integer[]) AS link_offset
       )
       INSERT INTO graph_benchmark.links (dataset_id, source, target, weight)
       SELECT
         $1,
         least(node_id, neighbor_id),
         greatest(node_id, neighbor_id),
         (
           0.35 +
           ((least(node_id, neighbor_id) * 31 + greatest(node_id, neighbor_id) * 17) % 6500)
             / 10000.0
         )::real
       FROM raw_links`,
      [datasetId, nodeCount, offsets],
    );

    await client.query(
      "CREATE INDEX links_dataset_source_idx ON graph_benchmark.links (dataset_id, source)",
    );
    await client.query(
      "CREATE INDEX links_dataset_target_idx ON graph_benchmark.links (dataset_id, target)",
    );
    await client.query(
      "CREATE INDEX links_dataset_weight_idx ON graph_benchmark.links (dataset_id, weight DESC)",
    );
    await client.query("ANALYZE graph_benchmark.nodes");
    await client.query("ANALYZE graph_benchmark.links");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const validation = await client.query(
    `SELECT
       (SELECT count(*)::integer FROM graph_benchmark.nodes WHERE dataset_id = $1) AS nodes,
       (SELECT count(*)::integer FROM graph_benchmark.links WHERE dataset_id = $1) AS links,
       (SELECT count(*)::integer FROM graph_benchmark.links WHERE source = target) AS self_links,
       (
         SELECT count(*)::integer
         FROM graph_benchmark.links link
         LEFT JOIN graph_benchmark.nodes source
           ON source.dataset_id = link.dataset_id AND source.id = link.source
         LEFT JOIN graph_benchmark.nodes target
           ON target.dataset_id = link.dataset_id AND target.id = link.target
         WHERE source.id IS NULL OR target.id IS NULL
       ) AS dangling_links,
       pg_database_size(current_database())::bigint AS database_bytes`,
    [datasetId],
  );
  const summary = validation.rows[0];
  if (
    summary.nodes !== nodeCount ||
    summary.links !== expectedLinkCount ||
    summary.self_links !== 0 ||
    summary.dangling_links !== 0
  ) {
    throw new Error(`Benchmark validation failed: ${JSON.stringify(summary)}`);
  }

  console.log(
    JSON.stringify(
      {
        database: databaseName,
        datasetId,
        nodes: summary.nodes,
        links: summary.links,
        degree: offsets.length * 2,
        offsets,
        databaseBytes: Number(summary.database_bytes),
        elapsedMs: Math.round(performance.now() - startedAt),
      },
      null,
      2,
    ),
  );
} finally {
  await client.end();
}
