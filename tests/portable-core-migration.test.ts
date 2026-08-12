import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, test } from "vitest";

const baseline = new URL("../db/migrations/0001_v1_baseline.sql", import.meta.url);

test("the v1 baseline installs the complete Portable Core schema", async () => {
  const postgres = new PGlite({ extensions: { vector } });
  try {
    await postgres.waitReady;
    await postgres.exec(await readFile(baseline, "utf8"));

    await expect(
      postgres.query("SELECT schema_revision, api_version FROM lore_system_state WHERE singleton"),
    ).resolves.toMatchObject({ rows: [{ schema_revision: 1, api_version: "v1" }] });
    await expect(
      postgres.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'embedding_generations',
            'episodes',
            'memory_proposals',
            'observations',
            'request_idempotency_records'
          )
        ORDER BY table_name
      `),
    ).resolves.toMatchObject({
      rows: [
        { table_name: "embedding_generations" },
        { table_name: "episodes" },
        { table_name: "memory_proposals" },
        { table_name: "observations" },
        { table_name: "request_idempotency_records" },
      ],
    });
    await expect(
      postgres.query(`
        SELECT relname, relrowsecurity
        FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN ('memories', 'memory_chunks', 'memory_proposals', 'observations')
        ORDER BY relname
      `),
    ).resolves.toMatchObject({
      rows: [
        { relname: "memories", relrowsecurity: true },
        { relname: "memory_chunks", relrowsecurity: true },
        { relname: "memory_proposals", relrowsecurity: true },
        { relname: "observations", relrowsecurity: true },
      ],
    });
  } finally {
    await postgres.close();
  }
});
