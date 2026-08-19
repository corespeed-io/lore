// Apply lore's migration chain to a DISPOSABLE benchmark database with the
// embedding-space width transformed to a non-lore value (for example the
// production-shaped 1536 track of the HAAS-71 extraction gate).
//
// Deployments never use this: lore's own schema pins 1024 as a v1 protocol
// invariant and the deployment wrapper (`bun run db:migrate`) is the only
// supported migration path. This script exists so a benchmark variant can
// exercise the engine's host-baked `embeddingDimensions` option against a
// schema whose vector columns, CHECKs, HNSW indexes, and SQL functions were
// generated at the same width — exactly what a non-lore host's own chain does.
//
// Usage:
//   DATABASE_URL=postgres://…/lore_bench_1536 \
//     node scripts/benchmark-migrate-dimensions.mjs 1536

import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/(^|_)bench(mark)?($|_)/i.test(databaseName)) {
  throw new Error("Refusing to run outside a database whose name contains bench or benchmark");
}

const dimensions = Number(process.argv[2]);
if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16_000) {
  throw new Error("Pass the embedding dimensions as an integer argument from 1 to 16000");
}

const migrationsUrl = new URL("../db/migrations/", import.meta.url);

function upSection(sql, name) {
  const upIndex = sql.indexOf("-- migrate:up");
  const downIndex = sql.indexOf("-- migrate:down");
  if (upIndex === -1 || downIndex === -1 || downIndex < upIndex) {
    throw new Error(`${name} is not a dbmate migration`);
  }
  return sql.slice(upIndex + "-- migrate:up".length, downIndex);
}

// The audited transformation: every 1024 in the baseline is embedding-space
// width EXCEPT the four `length(path) <= 1024` constraints, which stay.
function transform(sql) {
  return sql
    .replaceAll("vector(1024)", `vector(${dimensions})`)
    .replaceAll("vector_dims(embedding) = 1024", `vector_dims(embedding) = ${dimensions}`)
    .replaceAll("embedding_dimensions = 1024", `embedding_dimensions = ${dimensions}`)
    .replaceAll("<> 1024", `<> ${dimensions}`)
    .replaceAll("require 1024 dimensions", `require ${dimensions} dimensions`)
    .replace(/^(\s*)1024,$/gm, `$1${dimensions},`);
}

function assertNoResidualWidth(sql, name) {
  for (const line of sql.split("\n")) {
    if (line.includes("1024") && !line.includes("<= 1024")) {
      throw new Error(`${name} still contains an untransformed 1024: ${line.trim()}`);
    }
  }
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const migrationIds = (await readdir(migrationsUrl))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const migrationId of migrationIds) {
    const raw = await readFile(new URL(migrationId, migrationsUrl), "utf8");
    const sql =
      dimensions === 1024 ? upSection(raw, migrationId) : transform(upSection(raw, migrationId));
    if (dimensions !== 1024) assertNoResidualWidth(sql, migrationId);
    process.stderr.write(`Applying ${migrationId} at ${dimensions} dimensions...\n`);
    await client.query(sql);
  }
  process.stderr.write(`Benchmark schema ready at ${dimensions} dimensions.\n`);
} finally {
  await client.end();
}
