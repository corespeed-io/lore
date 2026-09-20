export interface PostgresQueryResult<Row> {
  rows: Row[];
}

export interface PostgresTransaction {
  query<Row>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<Row>>;
}

/**
 * The narrow Postgres transaction seam used by domain modules and PGlite tests.
 * Lore does not support interchangeable storage engines: SQL and transactional
 * consistency are part of this contract. Hosts establish database access policy
 * before engine operations; Lore OSS uses RLS for that policy.
 */
export interface PostgresDatabase {
  transaction<Result>(use: (transaction: PostgresTransaction) => Promise<Result>): Promise<Result>;
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
