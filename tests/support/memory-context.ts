import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { and, eq, type SQLWrapper, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { onTestFinished } from "vitest";
import { type LoreDatabase, throwDatabaseCause } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { ActorContext } from "@/lib/memory";

const ALICE_USER_ID = "10000000-0000-4000-8000-000000000001";
const BOB_USER_ID = "10000000-0000-4000-8000-000000000002";
const CAROL_USER_ID = "10000000-0000-4000-8000-000000000003";
const OPERATIONS_WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const RESEARCH_WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";

const migrationsFolder = new URL("../../db/drizzle", import.meta.url).pathname;

export interface MemoryTestContext {
  database: LoreDatabase;
  maintenanceDatabase: LoreDatabase;
  adminDatabase: LoreDatabase;
  alice: ActorContext;
  bob: ActorContext;
  carol: ActorContext;
  suspendMembership(actor: ActorContext): Promise<void>;
  close(): Promise<void>;
}

export async function createMemoryTestContext(): Promise<MemoryTestContext> {
  const postgres = new PGlite({ extensions: { vector } });
  await postgres.waitReady;
  const drizzleDatabase = drizzle({ client: postgres, schema });
  await migrate(drizzleDatabase, { migrationsFolder });
  await drizzleDatabase.insert(schema.users).values([
    { id: ALICE_USER_ID, displayName: "Alice" },
    { id: BOB_USER_ID, displayName: "Bob" },
    { id: CAROL_USER_ID, displayName: "Carol" },
  ]);
  await drizzleDatabase.insert(schema.workspaces).values([
    { id: OPERATIONS_WORKSPACE_ID, name: "Operations" },
    { id: RESEARCH_WORKSPACE_ID, name: "Research" },
  ]);
  await drizzleDatabase.insert(schema.memberships).values([
    { workspaceId: OPERATIONS_WORKSPACE_ID, userId: ALICE_USER_ID, role: "owner" },
    { workspaceId: OPERATIONS_WORKSPACE_ID, userId: BOB_USER_ID, role: "member" },
    { workspaceId: RESEARCH_WORKSPACE_ID, userId: CAROL_USER_ID, role: "owner" },
  ]);
  await postgres.exec("SET ROLE lore_app");

  function databaseForRole(role: "lore_app" | "lore_maintenance" | "NONE"): LoreDatabase {
    return {
      transaction: (use) =>
        drizzleDatabase.transaction(async (transaction) => {
          await transaction.execute(sql.raw(`SET LOCAL ROLE ${role}`));
          return use({
            async execute<Row>(statement: SQLWrapper) {
              try {
                const result = await transaction.execute<Record<string, unknown>>(statement);
                return { rows: result.rows as Row[] };
              } catch (error) {
                throwDatabaseCause(error);
              }
            },
          });
        }),
    };
  }

  let closePromise: Promise<void> | undefined;
  const context: MemoryTestContext = {
    database: databaseForRole("lore_app"),
    maintenanceDatabase: databaseForRole("lore_maintenance"),
    adminDatabase: databaseForRole("NONE"),
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
        await drizzleDatabase
          .update(schema.memberships)
          .set({ status: "suspended", updatedAt: sql`now()` })
          .where(
            and(
              eq(schema.memberships.workspaceId, actor.workspaceId),
              eq(schema.memberships.userId, actor.userId),
            ),
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
