import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, onTestFinished, test } from "vitest";
import { adoptMigrationHistory, migrationFiles } from "../scripts/lib/migration-preflight.mjs";

const migrationsUrl = new URL("../db/migrations/", import.meta.url);
const dbmateUpMarker = "-- migrate:up\n\n";
const dbmateDownMarker = "\n-- migrate:down\n";

function preDbmateChecksum(sql: string): string {
  if (!sql.startsWith(dbmateUpMarker) || !sql.endsWith(dbmateDownMarker)) {
    throw new Error("Migration does not have the expected dbmate wrapper");
  }
  const originalSql = sql.slice(dbmateUpMarker.length, -dbmateDownMarker.length);
  return createHash("sha256").update(originalSql).digest("hex");
}

async function preDbmateHistory(): Promise<Array<[string, string]>> {
  const ids = (await readdir(migrationsUrl)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  return Promise.all(
    ids.map(async (id): Promise<[string, string]> => {
      const sql = await readFile(new URL(id, migrationsUrl), "utf8");
      return [id, preDbmateChecksum(sql)];
    }),
  );
}

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
  for (const [id, checksum] of await preDbmateHistory()) {
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
