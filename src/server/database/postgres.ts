import {
  type PostgresDatabase,
  type PostgresTransaction,
  type PostgresTransactionOptions,
  statement,
  transactionHandle,
  transactionModes,
} from "@corespeed/lore-core";
import { Pool, type PoolConfig } from "pg";

export type LoreDatabaseRole = "lore_app" | "lore_maintenance";

const ROLES: readonly LoreDatabaseRole[] = ["lore_app", "lore_maintenance"];

export interface RuntimePostgresDatabase extends PostgresDatabase {
  close(): Promise<void>;
}

export interface PostgresDatabaseOptions {
  role?: LoreDatabaseRole;
  /**
   * Send a transaction's statements without waiting between them, so `BEGIN`,
   * settings, and every statement of a batch share one network wait. PostgreSQL
   * supports it natively; a proxy in between (Hyperdrive) must be verified first.
   */
  pipeline?: boolean;
}

/**
 * `LORE_POSTGRES_PIPELINE`: "1" turns pipelining on and "0" off; anything else
 * keeps the runtime's default (on for self-host, off on Workers until Hyperdrive
 * is verified).
 */
export function postgresPipeline(value: string | undefined, fallback: boolean): boolean {
  if (value === "1") return true;
  if (value === "0") return false;
  return fallback;
}

/**
 * Transactions on clients checked out of `pool`. The connection user must belong
 * to `role`, a NOLOGIN role: the first statement sets it with `set_config('role',
 * …, true)`, so RLS applies before any domain statement and the role resets at
 * COMMIT or ROLLBACK. A client whose ROLLBACK failed is destroyed, never reused.
 */
function transactionsOn(pool: Pool, role: LoreDatabaseRole): PostgresDatabase["transaction"] {
  if (!ROLES.includes(role)) throw new Error("Unsupported Lore database role");
  return async <Result>(
    use: (transaction: PostgresTransaction) => Promise<Result>,
    options?: PostgresTransactionOptions,
  ): Promise<Result> => {
    const modes = transactionModes(options);
    const client = await pool.connect();
    let reusable = true;
    const handle = transactionHandle(
      async (sql, params) => ({ rows: (await client.query(sql, [...params])).rows }),
      { opening: statement(modes ? `BEGIN ${modes}` : "BEGIN") },
    );
    try {
      handle.transaction.setLocal({ role });
      const result = await use(handle.transaction);
      await handle.commit();
      handle.committed();
      return result;
    } catch (error) {
      reusable = await handle.rollback();
      // A batch may have committed before the callback threw.
      if (handle.isCommitted()) handle.committed();
      throw error;
    } finally {
      client.release(reusable ? undefined : true);
    }
  };
}

/** A process-lifetime pool for Bun, self-host, and tooling. */
export function createPostgresDatabase(
  config: PoolConfig,
  options: PostgresDatabaseOptions = {},
): RuntimePostgresDatabase {
  const pool = new Pool({ ...config, pipeline: options.pipeline ?? true });
  // An idle client's socket error is reported on the pool; the pool drops it.
  pool.on("error", () => undefined);
  return {
    transaction: transactionsOn(pool, options.role ?? "lore_app"),
    close: () => pool.end(),
  };
}

/**
 * Connections for one Workers request, queue batch, or cron run. Create it inside
 * that context and close it when the context ends: no socket outlives it, and
 * Hyperdrive stays the pool across requests. Sequential work reuses one
 * connection; the second exists only for concurrent work such as context
 * retrieval's Memory and Code searches. Idle clients are never evicted, so a
 * long provider call between transactions does not open another connection.
 */
export function createRequestPostgresDatabase(
  config: PoolConfig,
  options: PostgresDatabaseOptions = {},
): RuntimePostgresDatabase {
  const pool = new Pool({
    ...config,
    max: 2,
    idleTimeoutMillis: 0,
    pipeline: options.pipeline ?? false,
  });
  pool.on("error", () => undefined);
  const transaction = transactionsOn(pool, options.role ?? "lore_app");
  let closed = false;
  return {
    transaction(use, transactionOptions) {
      if (closed) return Promise.reject(new Error("The request database is closed"));
      return transaction(use, transactionOptions);
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
