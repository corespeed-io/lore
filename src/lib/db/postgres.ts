import { Client, type ClientConfig, Pool, type PoolClient, type PoolConfig } from "pg";
import type { PostgresDatabase, PostgresQueryResult, PostgresTransaction } from "../db";

export interface RuntimePostgresDatabase extends PostgresDatabase {
  close(): Promise<void>;
}

function asTransaction(client: PoolClient): PostgresTransaction {
  return {
    async query<Row>(sql: string, params: unknown[] = []): Promise<PostgresQueryResult<Row>> {
      const result = await client.query(sql, params);
      return { rows: result.rows as Row[] };
    },
  };
}

async function runRlsTransaction<Result>(
  client: Pick<PoolClient, "query">,
  use: (transaction: PostgresTransaction) => Promise<Result>,
): Promise<Result> {
  try {
    await client.query("BEGIN");
    // The connection user must be a member of the NOLOGIN lore_app role.
    // SET LOCAL makes every request transaction fail closed under RLS and
    // automatically resets the role at COMMIT/ROLLBACK.
    await client.query("SET LOCAL ROLE lore_app");
    const result = await use(asTransaction(client as PoolClient));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export function createPostgresDatabase(config: PoolConfig): RuntimePostgresDatabase {
  const pool = new Pool(config);

  return {
    async transaction<Result>(use: (transaction: PostgresTransaction) => Promise<Result>) {
      const client = await pool.connect();
      try {
        return await runRlsTransaction(client, use);
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/**
 * Cloudflare Workers cannot reuse socket-backed clients across request contexts.
 * Hyperdrive performs the origin pooling, so each domain transaction creates and
 * closes a short-lived pg Client inside the current request.
 */
export function createRequestPostgresDatabase(config: ClientConfig): RuntimePostgresDatabase {
  return {
    async transaction<Result>(use: (transaction: PostgresTransaction) => Promise<Result>) {
      const client = new Client(config);
      await client.connect();
      try {
        return await runRlsTransaction(client, use);
      } finally {
        await client.end();
      }
    },
    close: async () => undefined,
  };
}
