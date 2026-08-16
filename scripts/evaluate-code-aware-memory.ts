import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import type { ActorContext } from "../src/lib/actor-context";
import type { PostgresDatabase } from "../src/lib/db";
import { runCodeAwareMemoryDependencyStressEvaluation } from "./lib/code-aware-memory-dependency-stress-evaluation";
import { runCodeAwareMemoryFoundationEvaluation } from "./lib/code-aware-memory-foundation-evaluation";

const ALICE_USER_ID = "10000000-0000-4000-8000-000000000071";
const BOB_USER_ID = "10000000-0000-4000-8000-000000000072";
const CAROL_USER_ID = "10000000-0000-4000-8000-000000000073";
const VISIBLE_WORKSPACE_ID = "20000000-0000-4000-8000-000000000071";
const FORBIDDEN_WORKSPACE_ID = "20000000-0000-4000-8000-000000000072";
const migrationsUrl = new URL("../db/migrations/", import.meta.url);

function optionalArgument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value?.trim()) throw new Error(`--${name} requires a value`);
  return value;
}

const outputPath = optionalArgument("output");
const suite = optionalArgument("suite") ?? "foundation";
if (!new Set(["dependency-stress", "foundation"]).has(suite)) {
  throw new Error("--suite must be foundation or dependency-stress");
}
const strict = process.argv.includes("--strict");
const postgres = new PGlite({ extensions: { pg_trgm, vector } });
await postgres.waitReady;

try {
  const migrationIds = (await readdir(migrationsUrl))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const migrationId of migrationIds) {
    await postgres.exec(await readFile(new URL(migrationId, migrationsUrl), "utf8"));
  }
  await postgres.query("INSERT INTO users (id, display_name) VALUES ($1, $2), ($3, $4), ($5, $6)", [
    ALICE_USER_ID,
    "Evaluation Alice",
    BOB_USER_ID,
    "Evaluation Bob",
    CAROL_USER_ID,
    "Evaluation Carol",
  ]);
  await postgres.query("INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)", [
    VISIBLE_WORKSPACE_ID,
    "Evaluation Visible",
    FORBIDDEN_WORKSPACE_ID,
    "Evaluation Forbidden",
  ]);
  await postgres.query(
    `INSERT INTO memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($4, $5, 'owner')`,
    [VISIBLE_WORKSPACE_ID, ALICE_USER_ID, BOB_USER_ID, FORBIDDEN_WORKSPACE_ID, CAROL_USER_ID],
  );
  await postgres.exec("SET ROLE lore_app");

  const database: PostgresDatabase = {
    transaction: (use) =>
      postgres.transaction(async (transaction) => {
        await transaction.query("SET LOCAL ROLE lore_app");
        return use({ query: (sql, params) => transaction.query(sql, params) });
      }),
  };
  const alice: ActorContext = { workspaceId: VISIBLE_WORKSPACE_ID, userId: ALICE_USER_ID };
  const bob: ActorContext = { workspaceId: VISIBLE_WORKSPACE_ID, userId: BOB_USER_ID };
  const carol: ActorContext = {
    workspaceId: FORBIDDEN_WORKSPACE_ID,
    userId: CAROL_USER_ID,
  };
  const fixture = {
    database,
    alice,
    bob,
    carol,
    suspendMembership: async (actor: ActorContext) => {
      await postgres.exec("RESET ROLE");
      try {
        await postgres.query(
          `UPDATE memberships
           SET status = 'suspended', updated_at = now()
           WHERE workspace_id = $1 AND user_id = $2`,
          [actor.workspaceId, actor.userId],
        );
      } finally {
        await postgres.exec("SET ROLE lore_app");
      }
    },
  };
  const report =
    suite === "dependency-stress"
      ? await runCodeAwareMemoryDependencyStressEvaluation(fixture)
      : await runCodeAwareMemoryFoundationEvaluation(fixture);
  const output = {
    ...report,
    environment: {
      adapter: "PGlite",
      ingestion: "prepared files (not Git-authenticated)",
      concurrency: 1,
      costUsd: 0,
      modelCalls: 0,
    },
    scope: {
      covered:
        suite === "dependency-stress"
          ? "Import aliases, re-exports, qualified calls, language variants, structural chunks, exact literals, and malformed source"
          : "Code retrieval, dependency honesty, Memory Code Evidence revalidation, proposal/citation workflow, and RLS revocation",
      excluded:
        "Git object authentication, model answer quality, hosted Postgres query plans, concurrency, and production latency SLOs",
    },
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  process.stdout.write(serialized);
  if (outputPath) {
    const absoluteOutputPath = resolve(outputPath);
    await mkdir(dirname(absoluteOutputPath), { recursive: true });
    await writeFile(absoluteOutputPath, serialized, "utf8");
  }
  if (strict && report.decision !== "pass") process.exitCode = 1;
} finally {
  await postgres.close();
}
