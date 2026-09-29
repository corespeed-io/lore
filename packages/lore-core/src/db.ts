import { LoreConfigurationError } from "./validation";

export interface PostgresQueryResult<Row> {
  rows: Row[];
}

export interface PostgresTransaction {
  query<Row>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<Row>>;
}

/**
 * How a transaction starts. Without options it runs at the server's default
 * isolation (READ COMMITTED), read-write.
 */
export interface PostgresTransactionOptions {
  isolation?: "repeatable read" | "serializable";
  readOnly?: boolean;
}

/**
 * The narrow Postgres transaction seam used by domain modules and PGlite tests.
 * Lore does not support interchangeable storage engines: SQL and transactional
 * consistency are part of this contract. Hosts establish database access policy
 * before engine operations; Lore OSS uses RLS for that policy.
 *
 * An implementation must start the transaction with `options` before any host
 * setup runs, and a wrapper must pass them on: once a statement has taken a
 * snapshot, PostgreSQL can no longer change the isolation level.
 */
export interface PostgresDatabase {
  transaction<Result>(
    use: (transaction: PostgresTransaction) => Promise<Result>,
    options?: PostgresTransactionOptions,
  ): Promise<Result>;
}

/** SQL for each isolation level, so the statement never carries the option's text. */
const ISOLATION_LEVELS = {
  "repeatable read": "REPEATABLE READ",
  serializable: "SERIALIZABLE",
} as const satisfies Record<NonNullable<PostgresTransactionOptions["isolation"]>, string>;

/**
 * The transaction modes `options` ask for, as `BEGIN` or `SET TRANSACTION` takes
 * them (for example "ISOLATION LEVEL REPEATABLE READ, READ ONLY"), or "" for none.
 */
export function transactionModes(options: PostgresTransactionOptions = {}): string {
  const modes: string[] = [];
  if (options.isolation !== undefined) {
    // The type admits only the table's keys, but a JavaScript caller can pass anything.
    const levels: Readonly<Record<string, string>> = ISOLATION_LEVELS;
    const level = Object.hasOwn(levels, options.isolation) ? levels[options.isolation] : undefined;
    if (!level) {
      throw new LoreConfigurationError(
        "isolation",
        "isolation must be repeatable read or serializable",
      );
    }
    modes.push(`ISOLATION LEVEL ${level}`);
  }
  if (options.readOnly) modes.push("READ ONLY");
  return modes.join(", ");
}

/** Opaque storage keys. They carry attribution, never membership or permissions. */
export interface MemoryStorageScope {
  partitionId: string;
  ownerId: string;
  sourceId?: string;
}

/**
 * A host-bound store. Every transaction must already enforce the caller's access
 * policy before invoking its callback, including subsequent retrieval rounds.
 * Core never installs identity context or chooses database privileges.
 */
export interface MemoryStorageContext extends MemoryStorageScope {
  database: PostgresDatabase;
}

export function isPostgresAccessDenied(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "42501" ||
    (typeof candidate.message === "string" &&
      /row-level security|permission denied/i.test(candidate.message))
  );
}
