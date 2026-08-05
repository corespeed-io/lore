import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const migrationsDirectory = fileURLToPath(new URL("../db/migrations", import.meta.url));
const client = new pg.Client({ connectionString: databaseUrl });
const lockId = 1_280_263_749; // stable project-scoped advisory lock key

await client.connect();
try {
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

  for (const id of migrationIds) {
    const sql = await readFile(new URL(`../db/migrations/${id}`, import.meta.url), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
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
