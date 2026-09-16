import { Client, type ClientConfig, Pool, type PoolClient, type PoolConfig } from "pg";
import type { PostgresDatabase, PostgresQueryResult, PostgresTransaction } from "./db";

export interface RuntimePostgresDatabase extends PostgresDatabase {
  close(): Promise<void>;
}

export interface PostgresDatabaseOptions {
  /** Host-owned transaction setup, run after BEGIN and before any domain operation. */
  initializeTransaction?: (transaction: PostgresTransaction) => Promise<void>;
}

function asTransaction(client: Pick<PoolClient, "query">): PostgresTransaction {
  return {
    async query<Row>(sql: string, params: unknown[] = []): Promise<PostgresQueryResult<Row>> {
      const result = await client.query(sql, params);
      return { rows: result.rows as Row[] };
    },
  };
}

async function runTransaction<Result>(
  client: Pick<PoolClient, "query">,
  use: (transaction: PostgresTransaction) => Promise<Result>,
  initializeTransaction: PostgresDatabaseOptions["initializeTransaction"],
): Promise<Result> {
  try {
    await client.query("BEGIN");
    const transaction = asTransaction(client);
    await initializeTransaction?.(transaction);
    const result = await use(transaction);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export function createPostgresDatabase(
  config: PoolConfig,
  options: PostgresDatabaseOptions = {},
): RuntimePostgresDatabase {
  const pool = new Pool(config);

  return {
    async transaction<Result>(use: (transaction: PostgresTransaction) => Promise<Result>) {
      const client = await pool.connect();
      try {
        return await runTransaction(client, use, options.initializeTransaction);
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/**
 * Use a fresh connection for each transaction when the host cannot reuse clients
 * across request contexts. The host may provide pooling outside this adapter.
 */
export function createRequestPostgresDatabase(
  config: ClientConfig,
  options: PostgresDatabaseOptions = {},
): RuntimePostgresDatabase {
  return {
    async transaction<Result>(use: (transaction: PostgresTransaction) => Promise<Result>) {
      const client = new Client(config);
      await client.connect();
      try {
        return await runTransaction(client, use, options.initializeTransaction);
      } finally {
        await client.end();
      }
    },
    close: async () => undefined,
  };
}
