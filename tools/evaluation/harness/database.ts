import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { sha256 } from "./hash";

/**
 * One disposable database per migration chain and embedding width. Two refs with
 * the same migrations share it, and with it every corpus already seeded there;
 * a ref whose migrations differ gets its own. Corpora live in their own
 * Workspaces, so nothing is ever truncated.
 */
export function evalDatabaseName(checkoutRoot: string, dimensions: number): string {
  const directory = join(checkoutRoot, "db/migrations");
  const digest = sha256(
    readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => `${name}\u0000${readFileSync(join(directory, name), "utf8")}`)
      .join("\u0001"),
  );
  return `lore_eval_bench_${dimensions}_${digest.slice(0, 12)}`;
}

export interface EvalDatabase {
  name: string;
  url: string;
  /** PostgreSQL's server_version_num; part of every run key. */
  serverVersion: string;
}

export async function ensureEvalDatabase(input: {
  serverUrl: string;
  checkoutRoot: string;
  dimensions: number;
  log(message: string): void;
}): Promise<EvalDatabase> {
  const name = evalDatabaseName(input.checkoutRoot, input.dimensions);
  const server = new URL(input.serverUrl);
  const databaseUrl = new URL(input.serverUrl);
  databaseUrl.pathname = `/${name}`;
  const admin = new pg.Client({ connectionString: server.toString() });
  await admin.connect();
  try {
    // Two refs may reach a new database at once; one creates and migrates it.
    await admin.query("SELECT pg_advisory_lock(hashtext($1))", [name]);
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!exists.rows.length) {
      input.log(`creating ${name}`);
      await admin.query(`CREATE DATABASE "${name}"`);
      const migrated = spawnSync(
        "bun",
        [
          "--no-env-file",
          "tools/evaluation/retrieval/migrate-dimensions.ts",
          String(input.dimensions),
        ],
        {
          cwd: input.checkoutRoot,
          env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
          encoding: "utf8",
        },
      );
      if (migrated.status !== 0) {
        await admin.query(`DROP DATABASE "${name}"`);
        throw new Error(`Migrating ${name} failed:\n${migrated.stderr.slice(-2_000)}`);
      }
    }
    await admin.query("SELECT pg_advisory_unlock(hashtext($1))", [name]);
    const version = await admin.query<{ server_version_num: string }>("SHOW server_version_num");
    return {
      name,
      url: databaseUrl.toString(),
      serverVersion: version.rows[0]?.server_version_num ?? "unknown",
    };
  } finally {
    await admin.end();
  }
}
