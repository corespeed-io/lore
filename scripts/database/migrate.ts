import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  appliedMigrationVersions,
  applyDirectMigration,
  DBMATE_MIGRATIONS_TABLE,
  MIGRATION_LOCK_ID,
  type MigrationFile,
  migrationFiles,
  pendingMigrationSteps,
  prepareDbmateHistory,
  recordDbmateChecksums,
  runMigrationPreflight,
} from "./lib/migration-preflight.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const migrationsDirectory = fileURLToPath(new URL("../../db/migrations", import.meta.url));

async function executableDbmate() {
  const executable = process.platform === "win32" ? "dbmate.exe" : "dbmate";
  const candidates = [
    process.env.LORE_DBMATE_BINARY,
    fileURLToPath(new URL(`../../.worker/${executable}`, import.meta.url)),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next explicit installation location.
    }
  }
  try {
    const { resolveBinary } = await import("dbmate");
    const binary = resolveBinary();
    await access(binary, constants.X_OK);
    return binary;
  } catch {
    // Production uses the bundled binary; source installs use dbmate's native package.
  }
  throw new Error("dbmate binary is unavailable; run bun install or build the self-host image");
}

function dbmateDatabaseUrl(value: string) {
  if (process.env.LORE_DBMATE_DATABASE_URL) return process.env.LORE_DBMATE_DATABASE_URL;
  const parsed = new URL(value);
  if (
    ["postgres:", "postgresql:"].includes(parsed.protocol) &&
    !parsed.searchParams.has("sslmode") &&
    ["", "localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
  ) {
    parsed.searchParams.set("sslmode", "disable");
  }
  return parsed.toString();
}

async function runDbmate(databaseUrl: string, directory: string) {
  const binary = await executableDbmate();
  const child = spawn(
    binary,
    [
      "--migrations-dir",
      directory,
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
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

// dbmate applies every pending file it can see and cannot stop at a version. When
// a transaction:false migration must follow this run, dbmate sees a temporary copy
// of only the prefix it may apply, written from the bytes that were checksummed.
async function runDbmateThrough(
  databaseUrl: string,
  migrations: readonly MigrationFile[],
  through: MigrationFile,
) {
  const visible = migrations.slice(0, migrations.indexOf(through) + 1);
  if (visible.length === migrations.length) return runDbmate(databaseUrl, migrationsDirectory);
  const directory = await mkdtemp(join(tmpdir(), "lore-migrations-"));
  try {
    for (const migration of visible) {
      await writeFile(join(directory, migration.id), migration.sql);
    }
    return await runDbmate(databaseUrl, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  await prepareDbmateHistory(client, migrations);

  const steps = pendingMigrationSteps(await appliedMigrationVersions(client), migrations);
  for (const step of steps) {
    if (step.kind === "direct") {
      // This session holds only a session-level advisory lock and never an open
      // transaction here, so each concurrent index build runs on its own.
      console.log(`Applying: ${step.migration.id} (transaction:false, one statement at a time)`);
      await applyDirectMigration(client, step.migration);
      console.log(`Applied: ${step.migration.id}`);
      continue;
    }
    const result = await runDbmateThrough(databaseUrl, migrations, step.through);
    // dbmate owns transactional SQL parsing and application. Lore adds
    // immutable-file checksums after every successfully recorded version so later
    // deployments fail closed.
    await recordDbmateChecksums(client, migrations);
    if (result.code !== 0) {
      throw new Error(
        `dbmate exited ${result.signal ? `after signal ${result.signal}` : `with status ${result.code}`}`,
      );
    }
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
