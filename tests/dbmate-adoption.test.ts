import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, onTestFinished, test } from "vitest";
import { adoptMigrationHistory, migrationFiles } from "../scripts/lib/migration-preflight.mjs";
import { DRIZZLE_CUTOVER, PRE_DBMATE_MIGRATIONS } from "../scripts/migration-baseline.mjs";

const migrationsUrl = new URL("../db/migrations/", import.meta.url);

async function migratedDatabase() {
  const postgres = new PGlite({ extensions: { vector } });
  await postgres.waitReady;
  const ids = (await readdir(migrationsUrl)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const id of ids) {
    await postgres.exec(await readFile(new URL(id, migrationsUrl), "utf8"));
  }
  onTestFinished(() => postgres.close());
  return postgres;
}

test("dbmate adopts the exact SQL ledger without changing Memory data", async () => {
  const postgres = await migratedDatabase();
  await postgres.exec(`
    CREATE TABLE schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO users (id, display_name)
    VALUES ('10000000-0000-4000-8000-000000000099', 'Preserved User');
    INSERT INTO workspaces (id, name)
    VALUES ('20000000-0000-4000-8000-000000000099', 'Preserved Workspace');
    INSERT INTO memberships (workspace_id, user_id, role)
    VALUES (
      '20000000-0000-4000-8000-000000000099',
      '10000000-0000-4000-8000-000000000099',
      'owner'
    );
    INSERT INTO memories (id, workspace_id, owner_user_id, content)
    VALUES (
      '30000000-0000-4000-8000-000000000099',
      '20000000-0000-4000-8000-000000000099',
      '10000000-0000-4000-8000-000000000099',
      'must survive dbmate adoption'
    );
  `);
  for (const [id, checksum] of PRE_DBMATE_MIGRATIONS) {
    await postgres.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [
      id,
      checksum,
    ]);
  }

  await expect(adoptMigrationHistory(postgres, await migrationFiles())).resolves.toEqual({
    adopted: true,
    source: "pre-dbmate",
  });

  const memory = await postgres.query<{ content: string; version: number }>(
    "SELECT content, version FROM memories WHERE id = $1",
    ["30000000-0000-4000-8000-000000000099"],
  );
  expect(memory.rows).toEqual([{ content: "must survive dbmate adoption", version: 1 }]);
  await expect(
    postgres.query("SELECT version, checksum FROM lore_schema_migrations ORDER BY version"),
  ).resolves.toMatchObject({
    rows: expect.arrayContaining([
      expect.objectContaining({
        version: "0001",
        checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      expect.objectContaining({
        version: "0009",
        checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]),
  });
  await expect(
    postgres.query("SELECT to_regclass('public.schema_migrations') AS relation"),
  ).resolves.toMatchObject({ rows: [{ relation: null }] });
});

test("dbmate adopts the exact Drizzle ledger without replaying schema DDL", async () => {
  const postgres = await migratedDatabase();
  await postgres.exec(`
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint NOT NULL
    );
  `);
  await postgres.query(
    "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
    [DRIZZLE_CUTOVER.hash, DRIZZLE_CUTOVER.createdAt],
  );

  await expect(adoptMigrationHistory(postgres, await migrationFiles())).resolves.toEqual({
    adopted: true,
    source: "drizzle",
  });
  await expect(
    postgres.query("SELECT to_regnamespace('drizzle') AS namespace"),
  ).resolves.toMatchObject({ rows: [{ namespace: null }] });
  await expect(
    postgres.query("SELECT count(*)::integer AS count FROM lore_schema_migrations"),
  ).resolves.toMatchObject({ rows: [{ count: 9 }] });
});
