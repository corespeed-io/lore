import { Client } from "pg";

// What every real-PostgreSQL smoke check shares: its disposable target and its
// lock waits. A smoke check never creates, resets, or drops a database.

/** A smoke target: a Postgres URL whose database has smoke as a distinct name token. */
export function parseSmokeDatabaseUrl(value: string): { databaseName: string; url: URL } {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("LORE_SMOKE_DATABASE_URL must be a Postgres URL");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^(?:[a-z0-9]+[_-])*smoke(?:[_-][a-z0-9]+)*$/i.test(databaseName)) {
    throw new Error(
      "LORE_SMOKE_DATABASE_URL must name a disposable database with smoke as a distinct token",
    );
  }
  return { databaseName, url };
}

/** Refuses a database that is not the expected one, or holds any schema or relation. */
export async function requireFreshDatabase(
  connectionString: string,
  expectedName: string,
): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{
      current_database: string;
      has_lore_schema: boolean;
      user_relation_count: string;
      user_schema_count: string;
    }>(`SELECT
         current_database() AS current_database,
         to_regnamespace('lore') IS NOT NULL AS has_lore_schema,
         (
           SELECT count(*)::text
           FROM pg_class relation
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname <> 'information_schema'
             AND namespace.nspname !~ '^pg_'
         ) AS user_relation_count,
         (
           SELECT count(*)::text
           FROM pg_namespace namespace
           WHERE namespace.nspname NOT IN ('information_schema', 'public')
             AND namespace.nspname !~ '^pg_'
         ) AS user_schema_count`);
    const state = result.rows[0];
    if (state?.current_database !== expectedName) {
      throw new Error("Postgres connected to an unexpected DB");
    }
    if (
      state.has_lore_schema ||
      Number(state.user_relation_count) !== 0 ||
      Number(state.user_schema_count) !== 0
    ) {
      throw new Error("A smoke check requires a fresh, empty disposable database");
    }
  } finally {
    await client.end();
  }
}

/**
 * Wait until `count` sessions queue behind a lock this client's own session holds,
 * so an unrelated waiter on a shared server cannot satisfy it. A second waiter on a
 * row queues behind the first one's tuple lock, not the holder's, so the count
 * follows the whole wait chain. `pg_locks` is read live and needs no statistics
 * privileges, unlike `pg_stat_activity`, whose snapshot an open transaction would
 * also freeze.
 */
export async function waitForLockWaiters(client: Client, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await client.query<{ waiting: number }>(
      `WITH RECURSIVE queued(pid) AS (
         SELECT pg_backend_pid()
         UNION
         SELECT waiting.pid
         FROM pg_locks waiting
         JOIN queued ON queued.pid = ANY (pg_blocking_pids(waiting.pid))
         WHERE NOT waiting.granted
       )
       SELECT (count(*) - 1)::integer AS waiting FROM queued`,
    );
    if ((result.rows[0]?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`Expected ${count} sessions waiting on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
