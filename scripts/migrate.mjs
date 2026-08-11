import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrationPreflight } from "./lib/migration-preflight.mjs";
import {
  BASELINE_MIGRATION_ID,
  hasCompleteLegacyBaseline,
  LEGACY_BASELINE_MIGRATIONS,
} from "./migration-baseline.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const migrationsDirectory = fileURLToPath(new URL("../db/migrations", import.meta.url));
const client = new pg.Client({ connectionString: databaseUrl });
const lockId = 1_280_263_749; // stable project-scoped advisory lock key

await client.connect();
try {
  const preflight = await runMigrationPreflight(client);
  if (!preflight.ok) {
    throw new Error(
      `Migration preflight failed: ${preflight.checks
        .filter((check) => !check.ok && !check.advisory)
        .map((check) => check.check)
        .join(", ")}`,
    );
  }
  await client.query("SELECT pg_advisory_lock($1)", [lockId]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrationIds = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const migrations = await Promise.all(
    migrationIds.map(async (id) => {
      const sql = await readFile(new URL(`../db/migrations/${id}`, import.meta.url), "utf8");
      return { id, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );

  const baseline = migrations.find(({ id }) => id === BASELINE_MIGRATION_ID);
  if (baseline) {
    const applied = await client.query("SELECT id, checksum FROM schema_migrations");
    const baselineApplied = applied.rows.some(({ id }) => id === BASELINE_MIGRATION_ID);

    if (!baselineApplied && hasCompleteLegacyBaseline(applied.rows)) {
      await client.query("BEGIN");
      try {
        // The original chain revoked PUBLIC function access before later functions
        // were created. Finish that grant hardening while adopting the equivalent
        // squashed schema so legacy and fresh databases converge on one baseline.
        await client.query("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lore FROM PUBLIC");
        await client.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lore TO lore_app");
        await client.query("DELETE FROM schema_migrations WHERE id = ANY($1::text[])", [
          [...LEGACY_BASELINE_MIGRATIONS.keys()],
        ]);
        await client.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [
          baseline.id,
          baseline.checksum,
        ]);
        await client.query("COMMIT");
        console.log(`adopted ${baseline.id} from legacy migration history`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  }

  for (const { id, sql, checksum } of migrations) {
    const applied = await client.query("SELECT checksum FROM schema_migrations WHERE id = $1", [
      id,
    ]);
    if (applied.rows[0]) {
      if (applied.rows[0].checksum !== checksum) {
        throw new Error(`Applied migration ${id} has been modified`);
      }
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [
        id,
        checksum,
      ]);
      await client.query("COMMIT");
      console.log(`applied ${id}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => undefined);
  await client.end();
}
