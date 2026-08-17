import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export const MINIMUM_POSTGRES_VERSION = 150000;
export const LATEST_SCHEMA_REVISION = 2;
export const MIGRATION_LOCK_ID = 1_280_263_749;
export const DBMATE_MIGRATIONS_TABLE = "lore_schema_migrations";

export function isSchemaRevisionSupported(revision, latest = LATEST_SCHEMA_REVISION) {
  return Number.isInteger(revision) && revision >= 1 && revision <= latest;
}

const migrationsDirectory = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

export function migrationVersion(id) {
  const version = /^([0-9]+)/.exec(id)?.[1];
  if (!version) throw new Error(`Migration ${id} does not begin with a numeric version`);
  return version;
}

export async function migrationFiles() {
  const ids = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const migrations = await Promise.all(
    ids.map(async (id) => {
      const sql = await readFile(new URL(`../../db/migrations/${id}`, import.meta.url), "utf8");
      return {
        id,
        version: migrationVersion(id),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
  const versions = new Set();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}`);
    }
    versions.add(migration.version);
  }
  return migrations;
}

export function dbmateHistoryStatus(applied, migrations) {
  const expected = new Map(migrations.map((migration) => [migration.version, migration.checksum]));
  const expectedVersions = migrations.map((migration) => migration.version);
  const appliedVersions = new Set(applied.map(({ version }) => version));
  const highestAppliedIndex = expectedVersions.reduce(
    (highest, version, index) => (appliedVersions.has(version) ? index : highest),
    -1,
  );
  return {
    modified: applied.filter(
      ({ version, checksum }) => expected.has(version) && expected.get(version) !== checksum,
    ),
    unknown: applied.filter(({ version }) => !expected.has(version)),
    missing: expectedVersions
      .slice(0, highestAppliedIndex + 1)
      .filter((version) => !appliedVersions.has(version)),
  };
}

async function relationExists(client, relation) {
  const result = await client.query("SELECT to_regclass($1) AS relation", [relation]);
  return result.rows[0]?.relation !== null;
}

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS present`,
    [tableName, columnName],
  );
  return result.rows[0]?.present === true;
}

async function readSchemaRevision(client) {
  if (!(await relationExists(client, "public.lore_system_state"))) return null;
  const result = await client.query(
    "SELECT schema_revision FROM lore_system_state WHERE singleton",
  );
  return result.rows[0] ? Number(result.rows[0].schema_revision) : null;
}

function expectedRevision(versions) {
  if (versions.length === 0) return null;
  return Math.max(...versions.map((version) => Number(version)));
}

function revisionIssue(versions, revision) {
  const expected = expectedRevision(versions);
  if (expected === null)
    return revision === null ? undefined : `unexpected schema revision ${revision}`;
  return revision === expected
    ? undefined
    : `schema revision ${revision ?? "missing"}; expected ${expected}`;
}

export async function inspectMigrationHistory(client, migrations) {
  migrations ??= await migrationFiles();
  // A pg Client serializes work on one socket. Keep these probes sequential so
  // pg@9 does not reject concurrent client.query calls.
  const dbmateExists = await relationExists(client, `public.${DBMATE_MIGRATIONS_TABLE}`);
  const domainExists = await relationExists(client, "public.memories");
  const revision = await readSchemaRevision(client);

  if (dbmateExists) {
    const hasChecksum = await columnExists(client, DBMATE_MIGRATIONS_TABLE, "checksum");
    const result = hasChecksum
      ? await client.query(
          `SELECT version, checksum FROM ${DBMATE_MIGRATIONS_TABLE} ORDER BY version`,
        )
      : await client.query(
          `SELECT version, NULL::text AS checksum FROM ${DBMATE_MIGRATIONS_TABLE} ORDER BY version`,
        );
    const status = dbmateHistoryStatus(result.rows, migrations);
    const revisionProblem = revisionIssue(
      result.rows.map(({ version }) => version),
      revision,
    );
    const issues = [
      ...status.modified.map(({ version, checksum }) =>
        checksum === null ? `missing-checksum:${version}` : `modified:${version}`,
      ),
      ...status.unknown.map(({ version }) => `unknown:${version}`),
      ...status.missing.map((version) => `missing:${version}`),
      ...(revisionProblem ? [revisionProblem] : []),
      ...(result.rows.length === 0 && domainExists
        ? ["empty ledger beside an existing Lore schema"]
        : []),
    ];
    return {
      kind: "dbmate",
      ok: issues.length === 0,
      detail: issues.join(", ") || "dbmate history verified",
      revision,
      versions: result.rows.map(({ version }) => version),
    };
  }

  if (domainExists || revision !== null) {
    return {
      kind: "invalid",
      ok: false,
      detail: "Lore schema exists without a recognized migration ledger",
      revision,
    };
  }
  return { kind: "fresh", ok: true, detail: "fresh database", revision: null };
}

async function ensureDbmateLedger(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS ${DBMATE_MIGRATIONS_TABLE} (
    version varchar(255) PRIMARY KEY,
    checksum text
  )`);
  await client.query(
    `ALTER TABLE ${DBMATE_MIGRATIONS_TABLE} ADD COLUMN IF NOT EXISTS checksum text`,
  );
}

export async function prepareDbmateHistory(client, migrations) {
  migrations ??= await migrationFiles();
  const history = await inspectMigrationHistory(client, migrations);
  if (!history.ok) throw new Error(`Migration history is invalid: ${history.detail}`);
  if (history.kind === "dbmate") return;

  await client.query("BEGIN");
  try {
    await ensureDbmateLedger(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function recordDbmateChecksums(client, migrations) {
  migrations ??= await migrationFiles();
  await ensureDbmateLedger(client);
  const result = await client.query(
    `SELECT version, checksum FROM ${DBMATE_MIGRATIONS_TABLE} ORDER BY version`,
  );
  const expected = new Map(migrations.map((migration) => [migration.version, migration.checksum]));
  await client.query("BEGIN");
  try {
    for (const row of result.rows) {
      const checksum = expected.get(row.version);
      if (!checksum) throw new Error(`dbmate applied unknown migration ${row.version}`);
      if (row.checksum !== null && row.checksum !== checksum) {
        throw new Error(`Applied migration ${row.version} has been modified`);
      }
      if (row.checksum === null) {
        await client.query(
          `UPDATE ${DBMATE_MIGRATIONS_TABLE} SET checksum = $2 WHERE version = $1`,
          [row.version, checksum],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runMigrationPreflight(client) {
  const checks = [];
  const server = await client.query(
    `SELECT
       current_setting('server_version_num')::integer AS version_num,
       current_database() AS database_name,
       current_user AS user_name,
       has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
       EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS vector_available`,
  );
  const row = server.rows[0];
  checks.push({
    check: "postgres_version",
    ok: Number(row.version_num) >= MINIMUM_POSTGRES_VERSION,
    detail: String(row.version_num),
  });
  checks.push({ check: "database_create_privilege", ok: row.can_create === true });
  checks.push({ check: "vector_extension_available", ok: row.vector_available === true });

  const migrations = await migrationFiles();
  const history = await inspectMigrationHistory(client, migrations);
  checks.push({ check: "migration_history", ok: history.ok, detail: history.detail });
  checks.push({
    check: "app_schema_compatibility",
    ok: history.revision === null || isSchemaRevisionSupported(history.revision),
    detail:
      history.revision === null
        ? "Lore schema will be created by migration"
        : `database=${history.revision}; application=${LATEST_SCHEMA_REVISION}`,
  });
  checks.push({
    check: "backup_acknowledgement",
    ok: process.env.LORE_MIGRATION_BACKUP_CONFIRMED === "1",
    advisory: true,
    detail:
      "Set LORE_MIGRATION_BACKUP_CONFIRMED=1 after verifying a restorable backup for production changes.",
  });

  return {
    ok: checks.every((check) => check.ok || check.advisory),
    database: row.database_name,
    user: row.user_name,
    migrationCount: migrations.length,
    latestSchemaRevision: LATEST_SCHEMA_REVISION,
    checks,
  };
}
