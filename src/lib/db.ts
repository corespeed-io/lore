import type { SQLWrapper } from "drizzle-orm";

export interface LoreTransaction {
  execute<Row>(statement: SQLWrapper): Promise<{ rows: Row[] }>;
}

/**
 * Lore's Drizzle transaction boundary. Postgres, transaction-scoped roles, and
 * database-enforced RLS are architectural requirements; this is not a generic
 * storage-provider abstraction.
 */
export interface LoreDatabase {
  transaction<Result>(use: (transaction: LoreTransaction) => Promise<Result>): Promise<Result>;
}

/** Drizzle preserves the driver error as `cause`; domain code needs its SQLSTATE. */
export function throwDatabaseCause(error: unknown): never {
  if (error && typeof error === "object" && "cause" in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) throw cause;
  }
  throw error;
}
