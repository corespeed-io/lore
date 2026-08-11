import { resolve } from "node:path";
import { type MigrationMeta, readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Client } from "pg";

export const MINIMUM_POSTGRES_VERSION = 150000;
export const LATEST_SCHEMA_REVISION = 9;
export const MIGRATION_LOCK_ID = 1_280_263_749;

const DRIZZLE_SCHEMA = "drizzle";
const DRIZZLE_TABLE = "__drizzle_migrations";
const MIGRATIONS_FOLDER = resolve(process.cwd(), "db/drizzle");

const migrationConfig = {
  migrationsFolder: MIGRATIONS_FOLDER,
  migrationsSchema: DRIZZLE_SCHEMA,
  migrationsTable: DRIZZLE_TABLE,
} as const;

/**
 * The only legacy ledger Lore adopts directly into Drizzle. It represents the
 * complete schema immediately before the cutover, not a second live history.
 */
export const LEGACY_CUTOVER_MIGRATIONS = new Map([
  ["0001_initial.sql", "79e160c1cd812f973baacb1d4bb10d9f10ee495fdcb73a64f0581cb0f14d5a40"],
  [
    "0002_memory_embedding_jobs.sql",
    "e1075a30e35e5d18f3c28c12f8366b42bf62481a0dd196995b23794ee1a038b5",
  ],
  ["0003_portable_core.sql", "4ba5ae39c9771fce5d2f16371974c140160e68e7a89e190f751153bc7651704b"],
  [
    "0004_english_lexical_search.sql",
    "edb1be778f9a19bbe4d0bba96360f344d2cdbdcb19d4face56ef684aa4ae5f7f",
  ],
  [
    "0005_memory_metadata_search.sql",
    "1e4efdc91f03e7922bfd16a9d6fbec0f6e49f80cf9b9d36a2ec66d64fa145d89",
  ],
  [
    "0006_memory_chunk_entity_aliases.sql",
    "66821ec21a99a91c6e6f89ede1985c737216d567b38dc70c5edcc45e827bfdf1",
  ],
  ["0007_agent_lifecycle.sql", "bd677a854281d84f55115b3f4b2fdf9d5d6a62f0d3f1d7266e870b83c4f62cec"],
  ["0008_memory_proposals.sql", "85f72f4b125a525369bbd274f3ee023d0688b8a36ecfa1947d53718280155036"],
  [
    "0009_observation_evidence.sql",
    "706f27c235b8040a406a49174c84cfc7986d22e36d3a751641e44528b825c627",
  ],
]);

interface LegacyMigrationRow {
  id: string;
  checksum: string;
}

interface DrizzleMigrationRow {
  hash: string;
  created_at: string | number;
}

interface MigrationHistoryIssue {
  id: string;
  reason: "missing" | "modified" | "unknown" | "duplicate";
}

export interface MigrationPreflightCheck {
  check: string;
  ok: boolean;
  advisory?: boolean;
  detail?: string;
}

export interface MigrationPreflightReport {
  ok: boolean;
  database: string;
  user: string;
  migrationCount: number;
  latestSchemaRevision: number;
  checks: MigrationPreflightCheck[];
}

export function drizzleMigrationFiles(): MigrationMeta[] {
  return readMigrationFiles(migrationConfig);
}

export function legacyCutoverIssues(applied: LegacyMigrationRow[]): MigrationHistoryIssue[] {
  const issues: MigrationHistoryIssue[] = [];
  const seen = new Set<string>();

  for (const row of applied) {
    if (seen.has(row.id)) {
      issues.push({ id: row.id, reason: "duplicate" });
      continue;
    }
    seen.add(row.id);
    const expected = LEGACY_CUTOVER_MIGRATIONS.get(row.id);
    if (expected === undefined) issues.push({ id: row.id, reason: "unknown" });
    else if (expected !== row.checksum) issues.push({ id: row.id, reason: "modified" });
  }

  for (const id of LEGACY_CUTOVER_MIGRATIONS.keys()) {
    if (!seen.has(id)) issues.push({ id, reason: "missing" });
  }

  return issues;
}

export function drizzleHistoryIssues(
  applied: DrizzleMigrationRow[],
  expected: MigrationMeta[],
): MigrationHistoryIssue[] {
  const issues: MigrationHistoryIssue[] = [];
  const expectedByTimestamp = new Map(
    expected.map((migration) => [migration.folderMillis, migration.hash]),
  );
  const seen = new Set<number>();

  for (const row of applied) {
    const timestamp = Number(row.created_at);
    const id = String(row.created_at);
    if (seen.has(timestamp)) {
      issues.push({ id, reason: "duplicate" });
      continue;
    }
    seen.add(timestamp);
    const expectedHash = expectedByTimestamp.get(timestamp);
    if (expectedHash === undefined) issues.push({ id, reason: "unknown" });
    else if (expectedHash !== row.hash) issues.push({ id, reason: "modified" });
  }

  const highestAppliedIndex = expected.reduce(
    (highest, migration, index) => (seen.has(migration.folderMillis) ? index : highest),
    -1,
  );
  for (const migration of expected.slice(0, highestAppliedIndex + 1)) {
    if (!seen.has(migration.folderMillis)) {
      issues.push({ id: String(migration.folderMillis), reason: "missing" });
    }
  }

  return issues;
}

function issueDetail(issues: MigrationHistoryIssue[]): string | undefined {
  return issues.map((issue) => `${issue.reason}:${issue.id}`).join(",") || undefined;
}

async function relationExists(client: Client, relation: string): Promise<boolean> {
  const result = await client.query<{ relation: string | null }>(
    "SELECT to_regclass($1) AS relation",
    [relation],
  );
  return result.rows[0]?.relation !== null;
}

async function readLegacyHistory(client: Client): Promise<LegacyMigrationRow[] | null> {
  if (!(await relationExists(client, "public.schema_migrations"))) return null;
  const result = await client.query<LegacyMigrationRow>(
    "SELECT id, checksum FROM public.schema_migrations ORDER BY id",
  );
  return result.rows;
}

async function readDrizzleHistory(client: Client): Promise<DrizzleMigrationRow[] | null> {
  if (!(await relationExists(client, `${DRIZZLE_SCHEMA}.${DRIZZLE_TABLE}`))) return null;
  const result = await client.query<DrizzleMigrationRow>(
    `SELECT hash, created_at FROM ${DRIZZLE_SCHEMA}.${DRIZZLE_TABLE} ORDER BY created_at`,
  );
  return result.rows;
}

async function readSchemaRevision(client: Client): Promise<number | null> {
  if (!(await relationExists(client, "public.lore_system_state"))) return null;
  const result = await client.query<{ schema_revision: number | string }>(
    "SELECT schema_revision FROM public.lore_system_state WHERE singleton",
  );
  return result.rows[0] ? Number(result.rows[0].schema_revision) : null;
}

export async function runMigrationPreflight(client: Client): Promise<MigrationPreflightReport> {
  const checks: MigrationPreflightCheck[] = [];
  const server = await client.query<{
    version_num: number | string;
    database_name: string;
    user_name: string;
    can_create: boolean;
    vector_available: boolean;
  }>(`SELECT
       current_setting('server_version_num')::integer AS version_num,
       current_database() AS database_name,
       current_user AS user_name,
       has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
       EXISTS (
         SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
       ) AS vector_available`);
  const row = server.rows[0];
  if (!row) throw new Error("Postgres preflight returned no server row");

  checks.push({
    check: "postgres_version",
    ok: Number(row.version_num) >= MINIMUM_POSTGRES_VERSION,
    detail: String(row.version_num),
  });
  checks.push({ check: "database_create_privilege", ok: row.can_create === true });
  checks.push({ check: "vector_extension_available", ok: row.vector_available === true });

  const expected = drizzleMigrationFiles();
  const legacy = await readLegacyHistory(client);
  const drizzleHistory = await readDrizzleHistory(client);

  if (legacy !== null) {
    const issues = legacyCutoverIssues(legacy);
    if (drizzleHistory?.length) {
      issues.push({ id: `${DRIZZLE_SCHEMA}.${DRIZZLE_TABLE}`, reason: "unknown" });
    }
    checks.push({
      check: "migration_history",
      ok: issues.length === 0,
      detail: issueDetail(issues) ?? "complete legacy history; ready for one-time Drizzle adoption",
    });
  } else if (drizzleHistory !== null) {
    const issues = drizzleHistoryIssues(drizzleHistory, expected);
    checks.push({
      check: "migration_history",
      ok: issues.length === 0,
      detail: issueDetail(issues) ?? "Drizzle journal verified",
    });
  } else {
    checks.push({ check: "migration_history", ok: true, detail: "fresh database" });
  }

  const revision = await readSchemaRevision(client);
  checks.push({
    check: "app_schema_compatibility",
    ok: revision === null || revision <= LATEST_SCHEMA_REVISION,
    detail:
      revision === null
        ? "Lore schema will be created by migration"
        : `database=${revision}; application=${LATEST_SCHEMA_REVISION}`,
  });
  if (legacy !== null) {
    checks.push({
      check: "legacy_cutover_revision",
      ok: revision === LATEST_SCHEMA_REVISION,
      detail: `database=${revision ?? "missing"}; required=${LATEST_SCHEMA_REVISION}`,
    });
  }

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
    migrationCount: expected.length,
    latestSchemaRevision: LATEST_SCHEMA_REVISION,
    checks,
  };
}

async function adoptLegacyHistory(client: Client, migration: MigrationMeta): Promise<boolean> {
  const legacy = await readLegacyHistory(client);
  if (legacy === null) return false;

  const issues = legacyCutoverIssues(legacy);
  if (issues.length > 0) {
    throw new Error(`Legacy migration history cannot be adopted: ${issueDetail(issues)}`);
  }
  const revision = await readSchemaRevision(client);
  if (revision !== LATEST_SCHEMA_REVISION) {
    throw new Error(
      `Legacy migration history is complete but schema revision is ${revision ?? "missing"}; expected ${LATEST_SCHEMA_REVISION}`,
    );
  }
  const existingDrizzleHistory = await readDrizzleHistory(client);
  if (existingDrizzleHistory?.length) {
    throw new Error("Both legacy and Drizzle migration histories contain records");
  }

  await client.query("BEGIN");
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${DRIZZLE_SCHEMA}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${DRIZZLE_SCHEMA}.${DRIZZLE_TABLE} (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint NOT NULL
    )`);
    await client.query(
      `INSERT INTO ${DRIZZLE_SCHEMA}.${DRIZZLE_TABLE} (hash, created_at) VALUES ($1, $2)`,
      [migration.hash, migration.folderMillis],
    );
    await client.query("DROP TABLE public.schema_migrations");
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function migrateLoreDatabase(client: Client): Promise<{ adoptedLegacy: boolean }> {
  const expected = drizzleMigrationFiles();
  if (expected.length === 0) throw new Error("No Drizzle migrations found");

  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  try {
    const preflight = await runMigrationPreflight(client);
    if (!preflight.ok) {
      throw new Error(
        `Migration preflight failed: ${preflight.checks
          .filter((check) => !check.ok && !check.advisory)
          .map((check) => `${check.check}${check.detail ? ` (${check.detail})` : ""}`)
          .join(", ")}`,
      );
    }

    const adoptedLegacy = await adoptLegacyHistory(client, expected[0]);
    const db = drizzle(client);
    await migrate(db, migrationConfig);

    const applied = await readDrizzleHistory(client);
    const issues = drizzleHistoryIssues(applied ?? [], expected);
    if (issues.length > 0 || (applied?.length ?? 0) !== expected.length) {
      const missingTail = expected
        .filter(
          (migration) => !applied?.some((row) => Number(row.created_at) === migration.folderMillis),
        )
        .map((migration) => ({ id: String(migration.folderMillis), reason: "missing" as const }));
      throw new Error(
        `Drizzle migration journal verification failed: ${issueDetail([...issues, ...missingTail])}`,
      );
    }
    if (await relationExists(client, "public.schema_migrations")) {
      throw new Error("Legacy schema_migrations ledger still exists after Drizzle cutover");
    }

    return { adoptedLegacy };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
  }
}
