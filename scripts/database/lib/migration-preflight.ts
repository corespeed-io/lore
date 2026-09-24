import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  migrationQueries,
  parseMigration,
  splitMigrationStatements,
  statementSql,
} from "./migration-statements.ts";
export const MINIMUM_POSTGRES_VERSION = 150000;
export const LATEST_SCHEMA_REVISION = 5;
export const MIGRATION_LOCK_ID = 1_280_263_749;
export const DBMATE_MIGRATIONS_TABLE = "lore_schema_migrations";

interface MigrationDatabase {
  query<Row extends object = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

export interface MigrationFile {
  id: string;
  version: string;
  sql: string;
  checksum: string;
}

interface AppliedMigration {
  version: string;
  checksum: string | null;
}

type MigrationHistory = {
  detail: string;
  revision: number | null;
} & (
  | { kind: "dbmate"; ok: boolean; versions: string[] }
  | { kind: "invalid"; ok: false }
  | { kind: "fresh"; ok: true }
);

interface PreflightCheck {
  check: string;
  ok: boolean;
  detail?: string;
  advisory?: boolean;
}

export function isSchemaRevisionSupported(revision: number, latest = LATEST_SCHEMA_REVISION) {
  return Number.isInteger(revision) && revision >= 1 && revision <= latest;
}

const migrationsDirectory = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));

export function migrationVersion(id: string) {
  const version = /^([0-9]+)/.exec(id)?.[1];
  if (!version) throw new Error(`Migration ${id} does not begin with a numeric version`);
  return version;
}

export async function migrationFiles(): Promise<MigrationFile[]> {
  const ids = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const migrations = await Promise.all(
    ids.map(async (id) => {
      const sql = await readFile(new URL(`../../../db/migrations/${id}`, import.meta.url), "utf8");
      return {
        id,
        version: migrationVersion(id),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
  const versions = new Set<string>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}`);
    }
    versions.add(migration.version);
  }
  return migrations;
}

/**
 * Replays the whole chain on a disposable database with no migration ledger (the
 * PGlite test and evaluation harnesses), sending each transaction:false migration
 * one statement at a time as the deployment wrapper does.
 */
export async function applyMigrationChain(execute: (sql: string) => Promise<unknown>) {
  for (const migration of await migrationFiles()) {
    for (const query of migrationQueries(migration.sql, migration.id)) await execute(query);
  }
}

export function dbmateHistoryStatus(
  applied: readonly AppliedMigration[],
  migrations: readonly Pick<MigrationFile, "version" | "checksum">[],
) {
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

async function relationExists(client: MigrationDatabase, relation: string) {
  const result = await client.query<{ relation: string | null }>(
    "SELECT to_regclass($1) AS relation",
    [relation],
  );
  return result.rows[0]?.relation !== null;
}

async function columnExists(client: MigrationDatabase, tableName: string, columnName: string) {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS present`,
    [tableName, columnName],
  );
  return result.rows[0]?.present === true;
}

async function readSchemaRevision(client: MigrationDatabase) {
  if (!(await relationExists(client, "public.lore_system_state"))) return null;
  const result = await client.query<{ schema_revision: number }>(
    "SELECT schema_revision FROM lore_system_state WHERE singleton",
  );
  return result.rows[0] ? Number(result.rows[0].schema_revision) : null;
}

function expectedRevision(versions: readonly string[]) {
  if (versions.length === 0) return null;
  return Math.max(...versions.map((version) => Number(version)));
}

function revisionIssue(versions: readonly string[], revision: number | null) {
  const expected = expectedRevision(versions);
  if (expected === null)
    return revision === null ? undefined : `unexpected schema revision ${revision}`;
  return revision === expected
    ? undefined
    : `schema revision ${revision ?? "missing"}; expected ${expected}`;
}

export async function inspectMigrationHistory(
  client: MigrationDatabase,
  migrations?: readonly MigrationFile[],
): Promise<MigrationHistory> {
  migrations ??= await migrationFiles();
  // A pg Client serializes work on one socket. Keep these probes sequential so
  // pg@9 does not reject concurrent client.query calls.
  const dbmateExists = await relationExists(client, `public.${DBMATE_MIGRATIONS_TABLE}`);
  const domainExists = await relationExists(client, "public.memories");
  const revision = await readSchemaRevision(client);

  if (dbmateExists) {
    const hasChecksum = await columnExists(client, DBMATE_MIGRATIONS_TABLE, "checksum");
    const result = hasChecksum
      ? await client.query<AppliedMigration>(
          `SELECT version, checksum FROM ${DBMATE_MIGRATIONS_TABLE} ORDER BY version`,
        )
      : await client.query<AppliedMigration>(
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

async function ensureDbmateLedger(client: MigrationDatabase) {
  await client.query(`CREATE TABLE IF NOT EXISTS ${DBMATE_MIGRATIONS_TABLE} (
    version varchar(255) PRIMARY KEY,
    checksum text
  )`);
  await client.query(
    `ALTER TABLE ${DBMATE_MIGRATIONS_TABLE} ADD COLUMN IF NOT EXISTS checksum text`,
  );
}

export async function prepareDbmateHistory(
  client: MigrationDatabase,
  migrations?: readonly MigrationFile[],
) {
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

export async function recordDbmateChecksums(
  client: MigrationDatabase,
  migrations?: readonly MigrationFile[],
) {
  migrations ??= await migrationFiles();
  await ensureDbmateLedger(client);
  const result = await client.query<AppliedMigration>(
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

export async function appliedMigrationVersions(client: MigrationDatabase) {
  const result = await client.query<{ version: string }>(
    `SELECT version FROM ${DBMATE_MIGRATIONS_TABLE} ORDER BY version`,
  );
  return result.rows.map(({ version }) => version);
}

/**
 * One step of `bun run db:migrate`. dbmate applies each run of consecutive
 * pending transactional migrations, through the run's last file; the wrapper
 * applies each transaction:false migration itself, because dbmate would send it
 * as one multi-statement query and PostgreSQL runs that as an implicit
 * transaction block.
 */
export type MigrationStep =
  | { kind: "dbmate"; through: MigrationFile }
  | { kind: "direct"; migration: MigrationFile };

export function pendingMigrationSteps(
  appliedVersions: Iterable<string>,
  migrations: readonly MigrationFile[],
): MigrationStep[] {
  const applied = new Set(appliedVersions);
  const steps: MigrationStep[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const transactional = parseMigration(migration.sql, migration.id).transaction;
    const previous = steps.at(-1);
    if (!transactional) steps.push({ kind: "direct", migration });
    else if (previous?.kind === "dbmate") previous.through = migration;
    else steps.push({ kind: "dbmate", through: migration });
  }
  return steps;
}

const SCHEMA_REVISION_UPDATE =
  /^UPDATE\s+(?:public\.)?lore_system_state\s+SET\s+schema_revision\s*=\s*(\d+)\b/i;

/**
 * Applies one transaction:false migration: every statement but the last runs on
 * its own, outside any transaction, so CREATE INDEX CONCURRENTLY can build without
 * blocking writes. The last statement must set schema_revision to the migration's
 * version, and it commits in one transaction with the ledger row: a failure at any
 * earlier point leaves the previous revision and no ledger row, so the next run
 * repeats the whole file (which is why such files drop before they build).
 */
export async function applyDirectMigration(client: MigrationDatabase, migration: MigrationFile) {
  const parsed = parseMigration(migration.sql, migration.id);
  if (parsed.transaction) throw new Error(`${migration.id} is transactional; dbmate applies it`);
  const statements = splitMigrationStatements(parsed.up, migration.id);
  const revisionUpdate = statements.at(-1);
  const revision = revisionUpdate
    ? SCHEMA_REVISION_UPDATE.exec(statementSql(revisionUpdate))
    : null;
  if (!revisionUpdate || Number(revision?.[1]) !== Number(migration.version)) {
    throw new Error(
      `${migration.id} must end with UPDATE public.lore_system_state SET schema_revision = ${Number(migration.version)}`,
    );
  }
  for (const statement of statements.slice(0, -1)) await client.query(statement);
  await client.query("BEGIN");
  try {
    await client.query(revisionUpdate);
    await client.query(
      `INSERT INTO ${DBMATE_MIGRATIONS_TABLE} (version, checksum) VALUES ($1, $2)`,
      [migration.version, migration.checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runMigrationPreflight(client: MigrationDatabase) {
  const checks: PreflightCheck[] = [];
  const server = await client.query<{
    version_num: number;
    database_name: string;
    user_name: string;
    can_create: boolean;
    vector_available: boolean;
  }>(
    `SELECT
       current_setting('server_version_num')::integer AS version_num,
       current_database() AS database_name,
       current_user AS user_name,
       has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
       EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS vector_available`,
  );
  const row = server.rows[0];
  if (!row) throw new Error("Migration preflight returned no server settings");
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
