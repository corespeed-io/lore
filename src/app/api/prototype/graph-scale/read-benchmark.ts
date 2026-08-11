import "server-only";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { GraphData, MemoryScope } from "@/lib/types";

interface NodeRow extends Record<string, unknown> {
  id: string;
  label: string;
  preview: string;
  type: string;
  scope: MemoryScope;
  updated_at: Date;
}

interface LinkRow extends Record<string, unknown> {
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
    const database = drizzle(client);
    const dataset = await database.execute<{ id: string; node_count: number }>(
      sql`SELECT id, node_count
       FROM graph_benchmark.datasets
       ORDER BY generated_at DESC
       LIMIT 1`,
    );
    const row = dataset.rows[0];
    if (!row) throw new Error("The graph benchmark database has not been seeded");

    const [nodeResult, linkResult] = await Promise.all([
      database.execute<NodeRow>(
        sql`SELECT id::text, label, preview, type, scope, updated_at
         FROM graph_benchmark.nodes
         WHERE dataset_id = ${row.id}
         ORDER BY id`,
      ),
      database.execute<LinkRow>(
        sql`SELECT source::text, target::text, weight
         FROM graph_benchmark.links
         WHERE dataset_id = ${row.id}
           AND least(target - source, ${row.node_count} - (target - source)) <= 4
         ORDER BY source, target`,
      ),
    ]);

    return {
      nodes: nodeResult.rows.map((node) => ({
        id: node.id,
        reference: node.id,
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
