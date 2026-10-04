import { LoreConfigurationError } from "./validation";

export interface PostgresQueryResult<Row> {
  rows: Row[];
}

/**
 * One parameterized statement. `Row` only types the result; nothing checks it at
 * run time, exactly as with {@link PostgresTransaction.query}.
 */
export interface PostgresStatement<Row = unknown> {
  readonly sql: string;
  readonly params: readonly unknown[];
  /** Type marker for the result row; never set. */
  readonly row?: Row;
}

export function statement<Row = unknown>(
  sql: string,
  params: readonly unknown[] = [],
): PostgresStatement<Row> {
  return { sql, params };
}

/** The results of a batch, one per statement, in statement order. */
export type PostgresBatchResults<Statements extends readonly PostgresStatement<unknown>[]> = {
  -readonly [Index in keyof Statements]: Statements[Index] extends PostgresStatement<infer Row>
    ? PostgresQueryResult<Row>
    : never;
};

export interface PostgresBatchOptions {
  /**
   * Send COMMIT behind the statements, so the whole transaction finishes in the
   * same network wait. Nothing may be queried afterwards.
   */
  commit?: boolean;
}

export interface PostgresTransaction {
  query<Row>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<Row>>;
  /**
   * Send statements whose inputs are already known without waiting between them.
   * PostgreSQL still runs them in order, each with its own READ COMMITTED snapshot,
   * so a later statement sees what an earlier one wrote. When one fails, the
   * transaction is aborted and the first failure in statement order is thrown.
   */
  batch<const Statements extends readonly PostgresStatement<unknown>[]>(
    statements: Statements,
    options?: PostgresBatchOptions,
  ): Promise<PostgresBatchResults<Statements>>;
  /**
   * Set transaction-local configuration parameters (`role` included), as
   * `set_config(name, value, true)` would, ahead of this transaction's next
   * statement. Pending settings travel in one statement; a later value for the
   * same name replaces an earlier pending one.
   */
  setLocal(settings: Readonly<Record<string, string>>): void;
  /**
   * Run `effect` once this transaction has committed, never when it rolls back.
   * Effects run in registration order; one that throws is ignored, because the
   * transaction has already committed.
   */
  afterCommit(effect: () => void): void;
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

/**
 * Send one statement on the adapter's connection. A driver in pipeline mode
 * writes it at once; one that is not queues it behind the statements before it.
 * Either way statements reach the server in call order.
 */
export type PostgresSend = (
  sql: string,
  params: readonly unknown[],
) => Promise<PostgresQueryResult<unknown>>;

export interface PostgresTransactionHandle {
  readonly transaction: PostgresTransaction;
  /** Whether any statement has been sent. */
  started(): boolean;
  /** Send COMMIT unless nothing was sent or a batch already committed. */
  commit(): Promise<void>;
  /**
   * Whether COMMIT succeeded, in a batch or through `commit`. A callback that throws
   * after its last batch committed leaves a committed transaction behind; its
   * adapter must still run the post-commit effects.
   */
  isCommitted(): boolean;
  /**
   * Send ROLLBACK when something was sent and not committed. Resolves false when
   * ROLLBACK itself failed, so the adapter must discard the connection.
   */
  rollback(): Promise<boolean>;
  /** Run post-commit effects. Call only once the commit is durable. */
  committed(): void;
}

/** The first failure in statement order, or every value. */
async function settleInOrder<Value>(promises: readonly Promise<Value>[]): Promise<Value[]> {
  const settled = await Promise.allSettled(promises);
  const values: Value[] = [];
  for (const outcome of settled) {
    if (outcome.status === "rejected") throw outcome.reason;
    values.push(outcome.value);
  }
  return values;
}

/**
 * The one implementation of {@link PostgresTransaction} every adapter wraps around
 * its connection. `opening` (`BEGIN …`, or `SET TRANSACTION …` where the driver has
 * already begun) and pending settings are sent together with the first statement,
 * so opening a transaction costs no network wait of its own.
 */
export function transactionHandle(
  send: PostgresSend,
  options: { opening?: PostgresStatement | null } = {},
): PostgresTransactionHandle {
  let opening = options.opening ?? null;
  const pendingSettings = new Map<string, string>();
  const effects: Array<() => void> = [];
  let sent = false;
  let committed = false;

  function dispatch(
    sql: string,
    params: readonly unknown[],
  ): Promise<PostgresQueryResult<unknown>> {
    if (committed) return Promise.reject(new Error("The transaction has already committed"));
    const preceding: Promise<PostgresQueryResult<unknown>>[] = [];
    if (opening) {
      preceding.push(send(opening.sql, opening.params));
      opening = null;
    }
    if (pendingSettings.size > 0) {
      const names = [...pendingSettings.keys()];
      const settingParams = names.flatMap((name) => [name, pendingSettings.get(name) ?? ""]);
      pendingSettings.clear();
      preceding.push(
        send(
          `SELECT ${names.map((_, index) => `set_config($${2 * index + 1}, $${2 * index + 2}, true)`).join(", ")}`,
          settingParams,
        ),
      );
    }
    sent = true;
    const own = send(sql, params);
    if (preceding.length === 0) return own;
    return settleInOrder([...preceding, own]).then((results) => {
      const result = results.at(-1);
      if (!result) throw new Error("Statement returned no result");
      return result;
    });
  }

  const transaction: PostgresTransaction = {
    async query<Row>(sql: string, params: unknown[] = []) {
      return (await dispatch(sql, params)) as PostgresQueryResult<Row>;
    },
    async batch<const Statements extends readonly PostgresStatement<unknown>[]>(
      statements: Statements,
      batchOptions: PostgresBatchOptions = {},
    ) {
      const pending = statements.map((item) => dispatch(item.sql, item.params));
      const commit = batchOptions.commit === true && (sent || pending.length > 0);
      if (commit) pending.push(dispatch("COMMIT", []));
      const results = await settleInOrder(pending);
      if (commit) committed = true;
      return results.slice(0, statements.length) as PostgresBatchResults<Statements>;
    },
    setLocal(settings) {
      for (const [name, value] of Object.entries(settings)) pendingSettings.set(name, value);
    },
    afterCommit(effect) {
      effects.push(effect);
    },
  };

  return {
    transaction,
    started: () => sent,
    isCommitted: () => committed,
    async commit() {
      if (!sent || committed) return;
      await send("COMMIT", []);
      committed = true;
    },
    async rollback() {
      if (!sent || committed) return true;
      try {
        await send("ROLLBACK", []);
        return true;
      } catch {
        return false;
      }
    },
    committed() {
      for (const effect of effects.splice(0)) {
        try {
          effect();
        } catch {
          // The transaction has committed; an effect cannot undo it.
        }
      }
    },
  };
}

/** A driver whose own `transaction(callback)` begins and commits around it (PGlite). */
export interface ManagedTransactionDriver {
  transaction<Result>(
    use: (transaction: {
      query<Row>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<Row>>;
    }) => Promise<Result>,
  ): Promise<Result>;
}

/**
 * A {@link PostgresDatabase} over a driver that manages its own transactions. The
 * requested modes are the first statement (`SET TRANSACTION …`), and post-commit
 * effects run once the driver's transaction resolves.
 */
export function managedTransactionDatabase(
  driver: ManagedTransactionDriver,
  options: {
    initialize?: (transaction: PostgresTransaction) => void | Promise<void>;
    observe?: (sql: string) => void;
  } = {},
): PostgresDatabase {
  return {
    async transaction(use, transactionOptions) {
      let handle: PostgresTransactionHandle | undefined;
      let result: Awaited<ReturnType<typeof use>>;
      try {
        result = await driver.transaction(async (raw) => {
          const modes = transactionModes(transactionOptions);
          handle = transactionHandle(
            (sql, params) => {
              options.observe?.(sql);
              return raw.query(sql, [...params]);
            },
            { opening: modes ? statement(`SET TRANSACTION ${modes}`) : null },
          );
          await options.initialize?.(handle.transaction);
          return use(handle.transaction);
        });
      } catch (error) {
        // A batch may have committed before the callback threw.
        if (handle?.isCommitted()) handle.committed();
        throw error;
      }
      handle?.committed();
      return result;
    },
  };
}

/**
 * A view of `base` whose every statement, single or batched, goes through `query`,
 * one after another, so a wrapper that observes, delays, or fails statements sees
 * batched ones too. Settings and post-commit effects belong to `base`.
 */
export function transactionThrough(
  base: PostgresTransaction,
  query: <Row>(sql: string, params: unknown[] | undefined) => Promise<PostgresQueryResult<Row>>,
): PostgresTransaction {
  return {
    query,
    async batch(statements, batchOptions = {}) {
      const results: PostgresQueryResult<unknown>[] = [];
      for (const item of statements) results.push(await query(item.sql, [...item.params]));
      if (batchOptions.commit) await base.batch([], { commit: true });
      return results as PostgresBatchResults<typeof statements>;
    },
    setLocal: (settings) => base.setLocal(settings),
    afterCommit: (effect) => base.afterCommit(effect),
  };
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
