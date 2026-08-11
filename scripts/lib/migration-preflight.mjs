import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  BASELINE_MIGRATION_ID,
  hasCompleteLegacyBaseline,
  LEGACY_BASELINE_MIGRATIONS,
} from "../migration-baseline.mjs";

export const MINIMUM_POSTGRES_VERSION = 150000;

export async function migrationFiles() {
  const directory = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
  const ids = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  return Promise.all(
    ids.map(async (id) => {
      const sql = await readFile(new URL(`../../db/migrations/${id}`, import.meta.url), "utf8");
      return { id, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

export function migrationHistoryStatus(applied, migrations) {
  const expected = new Map(migrations.map((migration) => [migration.id, migration.checksum]));
  const baselineApplied = applied.some(({ id }) => id === BASELINE_MIGRATION_ID);
  const adoptableLegacyBaseline = !baselineApplied && hasCompleteLegacyBaseline(applied);
  const effectiveApplied = new Set(
    applied.filter(({ id }) => expected.has(id)).map(({ id }) => id),
  );
  if (adoptableLegacyBaseline) effectiveApplied.add(BASELINE_MIGRATION_ID);
  const highestAppliedIndex = migrations.reduce(
    (highest, migration, index) => (effectiveApplied.has(migration.id) ? index : highest),
    -1,
  );
  return {
    modified: applied.filter(
      (migration) =>
        expected.has(migration.id) && expected.get(migration.id) !== migration.checksum,
    ),
    unknown: applied.filter(
      (migration) =>
        !expected.has(migration.id) &&
        !(adoptableLegacyBaseline && LEGACY_BASELINE_MIGRATIONS.has(migration.id)),
    ),
    missing: migrations
      .slice(0, highestAppliedIndex + 1)
      .filter((migration) => !effectiveApplied.has(migration.id)),
  };
}

export async function runMigrationPreflight(client) {
  const checks = [];
  const server = await client.query(
    `SELECT
       current_setting('server_version_num')::integer AS version_num,
       current_database() AS database_name,
       current_user AS user_name,
       has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
       EXISTS (
         SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
       ) AS vector_available`,
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
  const latestSchemaRevision = Math.max(
    ...migrations.map((migration) => Number(/^([0-9]+)/.exec(migration.id)?.[1] ?? 0)),
  );
  const historyExists = await client.query(
    "SELECT to_regclass('public.schema_migrations') AS table",
  );
  if (historyExists.rows[0]?.table) {
    const applied = await client.query("SELECT id, checksum FROM schema_migrations ORDER BY id");
    const { missing, modified, unknown } = migrationHistoryStatus(applied.rows, migrations);
    checks.push({
      check: "migration_checksums",
      ok: modified.length === 0 && unknown.length === 0 && missing.length === 0,
      detail:
        [
          ...modified.map((migration) => `modified:${migration.id}`),
          ...unknown.map((migration) => `unknown:${migration.id}`),
          ...missing.map((migration) => `missing:${migration.id}`),
        ].join(",") || undefined,
    });
  } else {
    checks.push({ check: "migration_checksums", ok: true, detail: "fresh database" });
  }
  const stateExists = await client.query("SELECT to_regclass('public.lore_system_state') AS table");
  if (stateExists.rows[0]?.table) {
    const state = await client.query(
      "SELECT schema_revision, api_version FROM lore_system_state WHERE singleton",
    );
    const revision = Number(state.rows[0]?.schema_revision);
    checks.push({
      check: "app_schema_compatibility",
      ok: Number.isInteger(revision) && revision <= latestSchemaRevision,
      detail: `database=${revision}; application=${latestSchemaRevision}; api=${state.rows[0]?.api_version ?? "unknown"}`,
    });
  } else {
    checks.push({
      check: "app_schema_compatibility",
      ok: true,
      detail: "portable-core state will be created by migration",
    });
  }
  checks.push({
    check: "backup_acknowledgement",
    ok: process.env.LORE_MIGRATION_BACKUP_CONFIRMED === "1",
    advisory: true,
    detail:
      "Set LORE_MIGRATION_BACKUP_CONFIRMED=1 after verifying a restorable backup for production changes.",
  });

  const blockingFailures = checks.filter((check) => !check.ok && !check.advisory);
  return {
    ok: blockingFailures.length === 0,
    database: row.database_name,
    user: row.user_name,
    migrationCount: migrations.length,
    latestSchemaRevision,
    checks,
  };
}
