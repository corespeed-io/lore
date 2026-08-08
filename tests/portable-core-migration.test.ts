import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, test } from "vitest";

const migrations = new URL("../db/migrations/", import.meta.url);

test("Portable Core adopts multiple job-only embedding spaces with one active generation", async () => {
  const postgres = new PGlite({ extensions: { vector } });
  try {
    await postgres.waitReady;
    await postgres.exec(await readFile(new URL("0001_initial.sql", migrations), "utf8"));
    await postgres.exec(
      await readFile(new URL("0002_memory_embedding_jobs.sql", migrations), "utf8"),
    );
    await postgres.exec(`
      INSERT INTO users (id, display_name)
      VALUES ('10000000-0000-4000-8000-000000000001', 'Alice');
      INSERT INTO workspaces (id, name)
      VALUES ('20000000-0000-4000-8000-000000000001', 'Workspace');
      INSERT INTO memories (id, workspace_id, owner_user_id, content)
      VALUES
        (
          '30000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000001',
          'First Memory'
        ),
        (
          '30000000-0000-4000-8000-000000000002',
          '20000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000001',
          'Second Memory'
        );
      INSERT INTO memory_embedding_jobs (
        id, workspace_id, memory_id, owner_user_id, memory_scope, memory_version,
        embedding_provider, embedding_model, embedding_revision
      ) VALUES
        (
          '40000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          '30000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000001',
          'shared', 1, 'ollama', 'model-a', 'revision-a'
        ),
        (
          '40000000-0000-4000-8000-000000000002',
          '20000000-0000-4000-8000-000000000001',
          '30000000-0000-4000-8000-000000000002',
          '10000000-0000-4000-8000-000000000001',
          'shared', 1, 'google', 'model-b', 'revision-b'
        );
    `);

    await postgres.exec(await readFile(new URL("0003_portable_core.sql", migrations), "utf8"));
    const generations = await postgres.query<{ status: string }>(
      "SELECT status::text FROM embedding_generations ORDER BY status, embedding_provider",
    );
    const jobs = await postgres.query<{ generation_id: string | null }>(
      "SELECT generation_id FROM memory_embedding_jobs",
    );

    expect(generations.rows.filter((row) => row.status === "active")).toHaveLength(1);
    expect(generations.rows.filter((row) => row.status === "building")).toHaveLength(1);
    expect(jobs.rows.every((row) => row.generation_id !== null)).toBe(true);
  } finally {
    await postgres.close();
  }
});
