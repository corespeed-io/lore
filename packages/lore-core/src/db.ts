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
