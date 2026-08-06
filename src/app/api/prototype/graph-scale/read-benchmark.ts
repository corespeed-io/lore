import "server-only";

import pg from "pg";
import type { GraphData, MemoryScope } from "@/lib/types";

interface NodeRow {
  id: string;
  label: string;
  preview: string;
  type: string;
  scope: MemoryScope;
  updated_at: Date;
}

interface LinkRow {
  source: string;
  target: string;
  weight: number;
}

export async function readGraphScaleBenchmark(): Promise<GraphData> {
  const connectionString = process.env.BENCHMARK_DATABASE_URL;
  if (!connectionString) throw new Error("BENCHMARK_DATABASE_URL is not configured");

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const dataset = await client.query<{ id: string; node_count: number }>(
      `SELECT id, node_count
       FROM graph_benchmark.datasets
       ORDER BY generated_at DESC
       LIMIT 1`,
    );
    const row = dataset.rows[0];
    if (!row) throw new Error("The graph benchmark database has not been seeded");

    const [nodeResult, linkResult] = await Promise.all([
      client.query<NodeRow>(
        `SELECT id::text, label, preview, type, scope, updated_at
         FROM graph_benchmark.nodes
         WHERE dataset_id = $1
         ORDER BY id`,
        [row.id],
      ),
      client.query<LinkRow>(
        `SELECT source::text, target::text, weight
         FROM graph_benchmark.links
         WHERE dataset_id = $1
           AND least(target - source, $2 - (target - source)) <= 4
         ORDER BY source, target`,
        [row.id, row.node_count],
      ),
    ]);

    return {
      nodes: nodeResult.rows.map((node) => ({
        id: node.id,
        label: node.label,
        preview: node.preview,
        type: node.type,
        scope: node.scope,
        updatedAt: node.updated_at.toISOString(),
      })),
      links: linkResult.rows.map((link) => ({
        source: link.source,
        target: link.target,
        kind: "affinity",
        weight: link.weight,
      })),
    };
  } finally {
    await client.end();
  }
}
