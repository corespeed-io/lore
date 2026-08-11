import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  adoptMigrationHistory,
  MIGRATION_LOCK_ID,
  migrationFiles,
  recordDbmateChecksums,
  runMigrationPreflight,
} from "./lib/migration-preflight.mjs";
import { DBMATE_MIGRATIONS_TABLE } from "./migration-baseline.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const migrationsDirectory = fileURLToPath(new URL("../db/migrations", import.meta.url));

async function executableDbmate() {
  const executable = process.platform === "win32" ? "dbmate.cmd" : "dbmate";
  const candidates = [
    process.env.LORE_DBMATE_BINARY,
    fileURLToPath(new URL(`../.worker/${executable}`, import.meta.url)),
    fileURLToPath(new URL(`../node_modules/.bin/${executable}`, import.meta.url)),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next explicit installation location.
    }
  }
  throw new Error("dbmate binary is unavailable; run bun install or build the self-host image");
}

function dbmateDatabaseUrl(value) {
  if (process.env.LORE_DBMATE_DATABASE_URL) return process.env.LORE_DBMATE_DATABASE_URL;
  const parsed = new URL(value);
  if (
    ["postgres:", "postgresql:"].includes(parsed.protocol) &&
    !parsed.searchParams.has("sslmode") &&
    ["", "localhost", "127.0.0.1", "::1", "postgres"].includes(parsed.hostname)
  ) {
    parsed.searchParams.set("sslmode", "disable");
  }
  return parsed.toString();
}

async function runDbmate() {
  const binary = await executableDbmate();
  const child = spawn(
    binary,
    [
      "--migrations-dir",
      migrationsDirectory,
      "--migrations-table",
      DBMATE_MIGRATIONS_TABLE,
      "--no-dump-schema",
      "migrate",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: dbmateDatabaseUrl(databaseUrl) },
    },
  );
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
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

  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  const migrations = await migrationFiles();
  const adoption = await adoptMigrationHistory(client, migrations);
  if (adoption.adopted) {
    console.log(`adopted ${adoption.source} migration history into dbmate without replaying DDL`);
  }

  const result = await runDbmate();
  // dbmate owns SQL parsing and application. Lore adds immutable-file checksums
  // after every successfully recorded version so later deployments fail closed.
  await recordDbmateChecksums(client, migrations);
  if (result.code !== 0) {
    throw new Error(
      `dbmate exited ${result.signal ? `after signal ${result.signal}` : `with status ${result.code}`}`,
    );
  }

  const postflight = await runMigrationPreflight(client);
  if (!postflight.ok) {
    throw new Error(
      `Migration postflight failed: ${postflight.checks
        .filter((check) => !check.ok && !check.advisory)
        .map((check) => `${check.check}${check.detail ? ` (${check.detail})` : ""}`)
        .join(", ")}`,
    );
  }
  console.log("dbmate migrations complete");
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
  await client.end();
}
