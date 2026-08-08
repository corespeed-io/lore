import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const databaseUrl = process.env.LORE_RESTORE_DATABASE_URL;
const requestedPath = process.env.LORE_BACKUP_PATH;
if (!databaseUrl) throw new Error("LORE_RESTORE_DATABASE_URL is required");
if (!requestedPath) throw new Error("LORE_BACKUP_PATH is required");

const target = new URL(databaseUrl);
const databaseName = decodeURIComponent(target.pathname.slice(1));
if (!databaseName || process.env.LORE_RESTORE_CONFIRM !== databaseName) {
  throw new Error(`Set LORE_RESTORE_CONFIRM=${databaseName} to confirm the exact restore target`);
}

const backupPath = resolve(requestedPath);
const manifest = JSON.parse(await readFile(`${backupPath}.manifest.json`, "utf8"));
const hash = createHash("sha256");
for await (const chunk of createReadStream(backupPath)) hash.update(chunk);
const checksum = hash.digest("hex");
const backupStats = await stat(backupPath);
if (
  manifest.format !== "lore-postgres-backup-v1" ||
  manifest.sha256 !== checksum ||
  manifest.bytes !== backupStats.size
) {
  throw new Error("Backup manifest or checksum is invalid");
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const existing = await client.query(
    `SELECT count(*)::integer AS count
     FROM pg_class relation
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public' AND relation.relkind = 'r'`,
  );
  if (existing.rows[0]?.count !== 0) {
    throw new Error("Restore target must be an empty database; no objects were changed");
  }
  await client.query(
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lore_app') THEN
         CREATE ROLE lore_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lore_maintenance') THEN
         CREATE ROLE lore_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
       END IF;
     END
     $$`,
  );
} finally {
  await client.end();
}

await new Promise((resolveProcess, reject) => {
  const restoreUrl = new URL(databaseUrl);
  const restorePassword = decodeURIComponent(restoreUrl.password);
  restoreUrl.password = "";
  const child = spawn(
    "pg_restore",
    ["--exit-on-error", "--no-owner", "--dbname", restoreUrl.toString(), backupPath],
    {
      env: { ...process.env, ...(restorePassword ? { PGPASSWORD: restorePassword } : {}) },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0 ? resolveProcess() : reject(new Error(`pg_restore exited with status ${code}`)),
  );
});

const verifier = new pg.Client({ connectionString: databaseUrl });
await verifier.connect();
try {
  const result = await verifier.query(
    `SELECT
       (SELECT schema_revision FROM lore_system_state WHERE singleton) AS schema_revision,
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'memories'::regclass) AS memories_rls,
       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector,
       has_table_privilege('lore_app', 'memories', 'SELECT') AS app_can_select,
       has_table_privilege('lore_maintenance', 'memory_embedding_jobs', 'SELECT')
         AS maintenance_can_select`,
  );
  const row = result.rows[0];
  if (
    !row?.memories_rls ||
    !row.has_vector ||
    !row.app_can_select ||
    !row.maintenance_can_select ||
    Number(row.schema_revision) < 3
  ) {
    throw new Error("Restored database failed Lore schema, RLS, or extension verification");
  }
  console.log(JSON.stringify({ status: "verified", database: databaseName, ...row }));
} finally {
  await verifier.end();
}
