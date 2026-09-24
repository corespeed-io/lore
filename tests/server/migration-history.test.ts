import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, onTestFinished, test } from "vitest";
import {
  applyDirectMigration,
  inspectMigrationHistory,
  type MigrationFile,
  migrationFiles,
  prepareDbmateHistory,
} from "../../scripts/database/lib/migration-preflight.ts";
import { migrationQueries } from "../../scripts/database/lib/migration-statements.ts";

const baselineUrl = new URL("../../db/migrations/0001_v1_baseline.sql", import.meta.url);

const CONCURRENT_INDEXES = [
  "memory_import_provenance_import_idx",
  "request_idempotency_records_episode_id_idx",
  "request_idempotency_records_memory_id_idx",
  "request_idempotency_records_proposal_accepted_idx",
  "request_idempotency_records_proposal_id_idx",
  "request_idempotency_records_proposal_target_idx",
];

async function database() {
  const postgres = new PGlite({ extensions: { pg_trgm, vector } });
  await postgres.waitReady;
  onTestFinished(() => postgres.close());
  return postgres;
}

// Stands in for dbmate: applies and records every transactional migration
// through `version`, the state db:migrate reaches before its direct step.
async function migrateThrough(postgres: PGlite, migrations: MigrationFile[], version: string) {
  await prepareDbmateHistory(postgres, migrations);
  for (const migration of migrations.filter((file) => file.version <= version)) {
    for (const query of migrationQueries(migration.sql, migration.id)) await postgres.exec(query);
    await postgres.query("INSERT INTO lore_schema_migrations (version, checksum) VALUES ($1, $2)", [
      migration.version,
      migration.checksum,
    ]);
  }
}

function migration(migrations: MigrationFile[], version: string) {
  const file = migrations.find((candidate) => candidate.version === version);
  if (!file) throw new Error(`migration ${version} is missing`);
  return file;
}

async function concurrentIndexes(postgres: PGlite) {
  const result = await postgres.query<{ name: string; valid: boolean }>(
    `SELECT class.relname AS name, index.indisvalid AS valid
     FROM pg_index index
     JOIN pg_class class ON class.oid = index.indexrelid
     WHERE class.relnamespace = 'public'::regnamespace AND class.relname = ANY($1::text[])
     ORDER BY class.relname`,
    [CONCURRENT_INDEXES],
  );
  return result.rows;
}

async function ledger(postgres: PGlite) {
  const result = await postgres.query<{ version: string; checksum: string | null }>(
    "SELECT version, checksum FROM lore_schema_migrations ORDER BY version",
  );
  return result.rows;
}

test("prepares and verifies the greenfield dbmate ledger", async () => {
  const postgres = await database();
  const migrations = await migrationFiles();
  const baseline = migrations[0];
  if (!baseline) throw new Error("v1 baseline migration is missing");
  await expect(inspectMigrationHistory(postgres, migrations)).resolves.toMatchObject({
    kind: "fresh",
    ok: true,
  });

  await prepareDbmateHistory(postgres, migrations);
  await postgres.exec(await readFile(baselineUrl, "utf8"));
  await postgres.query("INSERT INTO lore_schema_migrations (version, checksum) VALUES ($1, $2)", [
    baseline.version,
    baseline.checksum,
  ]);

  await expect(inspectMigrationHistory(postgres, migrations)).resolves.toMatchObject({
    kind: "dbmate",
    ok: true,
    revision: 1,
    versions: ["0001"],
  });
});

test("rejects a Lore schema without the current dbmate ledger", async () => {
  const postgres = await database();
  await postgres.exec(await readFile(baselineUrl, "utf8"));

  const migrations = await migrationFiles();
  await expect(inspectMigrationHistory(postgres, migrations)).resolves.toMatchObject({
    kind: "invalid",
    ok: false,
    detail: "Lore schema exists without a recognized migration ledger",
  });
  await expect(prepareDbmateHistory(postgres, migrations)).rejects.toThrow(
    "Lore schema exists without a recognized migration ledger",
  );
});

test("rejects a modified v1 baseline checksum", async () => {
  const postgres = await database();
  await postgres.exec(await readFile(baselineUrl, "utf8"));
  await postgres.exec(`
    CREATE TABLE lore_schema_migrations (
      version varchar(255) PRIMARY KEY,
      checksum text
    );
    INSERT INTO lore_schema_migrations (version, checksum) VALUES ('0001', 'modified');
  `);

  await expect(inspectMigrationHistory(postgres, await migrationFiles())).resolves.toMatchObject({
    kind: "dbmate",
    ok: false,
    detail: expect.stringContaining("modified:0001"),
  });
});

test("0005 cannot run as one query, so the wrapper applies it statement by statement", async () => {
  const postgres = await database();
  const migrations = await migrationFiles();
  const concurrent = migration(migrations, "0005");
  await migrateThrough(postgres, migrations, "0004");

  // dbmate sends a transaction:false file as one multi-statement query.
  await expect(postgres.exec(concurrent.sql)).rejects.toThrow(
    "cannot run inside a transaction block",
  );
  await expect(concurrentIndexes(postgres)).resolves.toEqual([]);

  await applyDirectMigration(postgres, concurrent);

  await expect(concurrentIndexes(postgres)).resolves.toEqual(
    CONCURRENT_INDEXES.map((name) => ({ name, valid: true })),
  );
  await expect(ledger(postgres)).resolves.toContainEqual({
    version: "0005",
    checksum: concurrent.checksum,
  });
  await expect(inspectMigrationHistory(postgres, migrations)).resolves.toMatchObject({
    kind: "dbmate",
    ok: true,
    revision: 5,
  });
});

test("a stopped 0005 run records nothing, and the rerun rebuilds an INVALID index", async () => {
  const postgres = await database();
  const migrations = await migrationFiles();
  const concurrent = migration(migrations, "0005");
  await migrateThrough(postgres, migrations, "0004");
  // A table under an index's name makes that index's DROP INDEX fail midway.
  await postgres.exec("CREATE TABLE public.request_idempotency_records_episode_id_idx (id int)");

  await expect(applyDirectMigration(postgres, concurrent)).rejects.toThrow("is not an index");

  // Earlier statements committed on their own; the revision and ledger did not move.
  await expect(concurrentIndexes(postgres)).resolves.toHaveLength(4);
  await expect(ledger(postgres)).resolves.not.toContainEqual(
    expect.objectContaining({ version: "0005" }),
  );
  await expect(inspectMigrationHistory(postgres, migrations)).resolves.toMatchObject({
    ok: true,
    revision: 4,
  });

  // A cancelled concurrent build leaves exactly this behind.
  await postgres.exec(
    `UPDATE pg_index SET indisvalid = false
     WHERE indexrelid = 'public.request_idempotency_records_memory_id_idx'::regclass`,
  );
  await postgres.exec("DROP TABLE public.request_idempotency_records_episode_id_idx");
  await applyDirectMigration(postgres, concurrent);

  await expect(concurrentIndexes(postgres)).resolves.toEqual(
    CONCURRENT_INDEXES.map((name) => ({ name, valid: true })),
  );
  await expect(inspectMigrationHistory(postgres, migrations)).resolves.toMatchObject({
    ok: true,
    revision: 5,
  });
});

test("a transaction:false migration must end with its own schema revision", async () => {
  const postgres = await database();
  const migrations = await migrationFiles();
  await migrateThrough(postgres, migrations, "0004");
  const build =
    "CREATE INDEX CONCURRENTLY stray_idx ON public.request_idempotency_records (workspace_id);";
  const file = (statements: string): MigrationFile => ({
    id: "0005_stray.sql",
    version: "0005",
    sql: `-- migrate:up transaction:false\n${statements}\n-- migrate:down\n`,
    checksum: "stray",
  });

  await expect(applyDirectMigration(postgres, file(build))).rejects.toThrow(
    "must end with UPDATE public.lore_system_state SET schema_revision = 5",
  );
  await expect(
    applyDirectMigration(
      postgres,
      file(`${build}\nUPDATE public.lore_system_state SET schema_revision = 6;`),
    ),
  ).rejects.toThrow("schema_revision = 5");
  // Validation happens before any statement runs.
  await expect(
    postgres.query("SELECT to_regclass('public.stray_idx') AS index"),
  ).resolves.toMatchObject({ rows: [{ index: null }] });
  await expect(applyDirectMigration(postgres, migration(migrations, "0004"))).rejects.toThrow(
    "is transactional",
  );
});
