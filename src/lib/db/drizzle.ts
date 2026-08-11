import { type SQLWrapper, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, type ClientConfig, Pool, type PoolConfig } from "pg";
import { type LoreDatabase, type LoreTransaction, throwDatabaseCause } from "../db";
import * as schema from "./schema";

export interface RuntimeLoreDatabase extends LoreDatabase {
  close(): Promise<void>;
}

export type LoreDatabaseRole = "lore_app" | "lore_maintenance";

export interface DrizzleDatabaseOptions {
  role?: LoreDatabaseRole;
}

function roleStatement(role: LoreDatabaseRole) {
  switch (role) {
    case "lore_app":
      return sql`SET LOCAL ROLE lore_app`;
    case "lore_maintenance":
      return sql`SET LOCAL ROLE lore_maintenance`;
    default:
      throw new Error("Unsupported Lore database role");
  }
}

function asLoreTransaction(
  transaction: Parameters<Parameters<ReturnType<typeof drizzle>["transaction"]>[0]>[0],
): LoreTransaction {
  return {
    async execute<Row>(statement: SQLWrapper) {
      try {
        const result = await transaction.execute<Record<string, unknown>>(statement);
        return { rows: result.rows as Row[] };
      } catch (error) {
        throwDatabaseCause(error);
      }
    },
  };
}

export function createDrizzleDatabase(
  config: PoolConfig,
  options: DrizzleDatabaseOptions = {},
): RuntimeLoreDatabase {
  const pool = new Pool(config);
  const database = drizzle({ client: pool, schema });
  const role = options.role ?? "lore_app";

  return {
    transaction: (use) =>
      database.transaction(async (transaction) => {
        await transaction.execute(roleStatement(role));
        return use(asLoreTransaction(transaction));
      }),
    close: () => pool.end(),
  };
}

/**
 * Cloudflare Workers cannot reuse socket-backed clients across request contexts.
 * Hyperdrive performs origin pooling, so each domain transaction creates and
 * closes a short-lived pg Client inside the current request.
 */
export function createRequestDrizzleDatabase(
  config: ClientConfig,
  options: DrizzleDatabaseOptions = {},
): RuntimeLoreDatabase {
  const role = options.role ?? "lore_app";
  return {
    async transaction(use) {
      const client = new Client(config);
      await client.connect();
      try {
        const database = drizzle({ client, schema });
        return await database.transaction(async (transaction) => {
          await transaction.execute(roleStatement(role));
          return use(asLoreTransaction(transaction));
        });
      } finally {
        await client.end();
      }
    },
    close: async () => undefined,
  };
}
