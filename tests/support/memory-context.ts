import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { onTestFinished } from "vitest";
import type { PostgresDatabase } from "@/lib/db";
import type { ActorContext } from "@/lib/memory";

const ALICE_USER_ID = "10000000-0000-4000-8000-000000000001";
const BOB_USER_ID = "10000000-0000-4000-8000-000000000002";
const CAROL_USER_ID = "10000000-0000-4000-8000-000000000003";
const OPERATIONS_WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const RESEARCH_WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";

const migrationsUrl = new URL("../../db/migrations/", import.meta.url);

async function migrate(postgres: PGlite): Promise<void> {
  const migrationIds = (await readdir(migrationsUrl))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const migrationId of migrationIds) {
    const migrationUrl = new URL(migrationId, migrationsUrl);
    await postgres.exec(await readFile(migrationUrl, "utf8"));
  }
}

export interface MemoryTestContext {
  database: PostgresDatabase;
  alice: ActorContext;
  bob: ActorContext;
  carol: ActorContext;
  suspendMembership(actor: ActorContext): Promise<void>;
  close(): Promise<void>;
}

export async function createMemoryTestContext(): Promise<MemoryTestContext> {
  const postgres = new PGlite({ extensions: { vector } });
  await postgres.waitReady;
  await migrate(postgres);
  await postgres.query("INSERT INTO users (id, display_name) VALUES ($1, $2), ($3, $4), ($5, $6)", [
    ALICE_USER_ID,
    "Alice",
    BOB_USER_ID,
    "Bob",
    CAROL_USER_ID,
    "Carol",
  ]);
  await postgres.query("INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)", [
    OPERATIONS_WORKSPACE_ID,
    "Operations",
    RESEARCH_WORKSPACE_ID,
    "Research",
  ]);
  await postgres.query(
    `INSERT INTO memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [OPERATIONS_WORKSPACE_ID, ALICE_USER_ID, BOB_USER_ID],
  );
  await postgres.query(
    `INSERT INTO memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [RESEARCH_WORKSPACE_ID, CAROL_USER_ID],
  );
  await postgres.exec("SET ROLE lore_app");

  let closePromise: Promise<void> | undefined;
  const context: MemoryTestContext = {
    database: {
      transaction: (use) =>
        postgres.transaction((transaction) =>
          use({
            query: (sql, params) => transaction.query(sql, params),
          }),
        ),
    },
    alice: {
      workspaceId: OPERATIONS_WORKSPACE_ID,
      userId: ALICE_USER_ID,
    },
    bob: {
      workspaceId: OPERATIONS_WORKSPACE_ID,
      userId: BOB_USER_ID,
    },
    carol: {
      workspaceId: RESEARCH_WORKSPACE_ID,
      userId: CAROL_USER_ID,
    },
    suspendMembership: async (actor) => {
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
    close: () => {
      closePromise ??= postgres.close();
      return closePromise;
    },
  };
  onTestFinished(() => context.close());
  return context;
}
