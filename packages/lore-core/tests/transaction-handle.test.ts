import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { describe, expect, test } from "vitest";
import {
  createMemoryGraphModule,
  createMemoryModule,
  type MemoryStorageContext,
  managedTransactionDatabase,
  type PostgresDatabase,
  type PostgresQueryResult,
  type PostgresSend,
  statement,
  transactionHandle,
  transactionModes,
  transactionThrough,
} from "../src/index";

/** A sender that answers every statement with its own text, once released. */
function heldSender(fail: Readonly<Record<string, Error>> = {}) {
  const sent: Array<{ sql: string; params: readonly unknown[] }> = [];
  const releases: Array<() => void> = [];
  const send: PostgresSend = (sql, params) => {
    sent.push({ sql, params });
    return new Promise<PostgresQueryResult<unknown>>((resolve, reject) => {
      releases.push(() => {
        const failure = fail[sql];
        if (failure) reject(failure);
        else resolve({ rows: [{ sql }] });
      });
    });
  };
  return {
    send,
    sent,
    /** Answer every statement sent so far, last first, as a reordering proxy might. */
    releaseAll() {
      for (const release of releases.splice(0).reverse()) release();
    },
  };
}

describe("transactionHandle", () => {
  test("BEGIN and pending settings go out with the first statement, without waiting", async () => {
    const sender = heldSender();
    const handle = transactionHandle(sender.send, { opening: statement("BEGIN") });
    handle.transaction.setLocal({ role: "lore_app", "lore.workspace_id": "first" });
    handle.transaction.setLocal({ "lore.workspace_id": "second" });

    const pending = handle.transaction.query("SELECT 1");
    expect(handle.started()).toBe(true);
    expect(sender.sent).toEqual([
      { sql: "BEGIN", params: [] },
      {
        sql: "SELECT set_config($1, $2, true), set_config($3, $4, true)",
        params: ["role", "lore_app", "lore.workspace_id", "second"],
      },
      { sql: "SELECT 1", params: [] },
    ]);
    sender.releaseAll();
    await expect(pending).resolves.toEqual({ rows: [{ sql: "SELECT 1" }] });

    // Opening and settings go out once; a later setting travels with its statement.
    handle.transaction.setLocal({ "lore.agent_id": "" });
    const next = handle.transaction.query("SELECT 2");
    expect(sender.sent.slice(3).map((item) => item.sql)).toEqual([
      "SELECT set_config($1, $2, true)",
      "SELECT 2",
    ]);
    sender.releaseAll();
    await next;
  });

  test("a batch sends every statement before any reply and returns results in order", async () => {
    const sender = heldSender();
    const { transaction } = transactionHandle(sender.send);

    const pending = transaction.batch([statement("SELECT 1"), statement("SELECT 2", [2])], {
      commit: true,
    });
    expect(sender.sent.map((item) => item.sql)).toEqual(["SELECT 1", "SELECT 2", "COMMIT"]);
    sender.releaseAll();
    await expect(pending).resolves.toEqual([
      { rows: [{ sql: "SELECT 1" }] },
      { rows: [{ sql: "SELECT 2" }] },
    ]);
    await expect(transaction.query("SELECT 3")).rejects.toThrow(/already committed/);
  });

  test("the first failure in statement order is the one rethrown", async () => {
    const first = new Error("relation does not exist");
    const aborted = new Error("current transaction is aborted");
    const sender = heldSender({ "SELECT broken": first, "SELECT after": aborted });
    const { transaction } = transactionHandle(sender.send);

    const pending = transaction.batch([
      statement("SELECT before"),
      statement("SELECT broken"),
      statement("SELECT after"),
    ]);
    // Replies settle last first, so the later failure is known before the earlier one.
    sender.releaseAll();
    await expect(pending).rejects.toBe(first);
  });

  test("a failing setting or opening fails the statement that carried it", async () => {
    const refused = new Error("role does not exist");
    const sender = heldSender({ "SELECT set_config($1, $2, true)": refused });
    const handle = transactionHandle(sender.send, { opening: statement("BEGIN") });
    handle.transaction.setLocal({ role: "missing" });

    const pending = handle.transaction.query("SELECT 1");
    sender.releaseAll();
    await expect(pending).rejects.toBe(refused);
  });

  test("commit and rollback send nothing when no statement was sent", async () => {
    const sender = heldSender();
    const handle = transactionHandle(sender.send, { opening: statement("BEGIN") });
    handle.transaction.setLocal({ role: "lore_app" });

    await handle.commit();
    await expect(handle.rollback()).resolves.toBe(true);
    expect(handle.started()).toBe(false);
    expect(sender.sent).toEqual([]);
  });

  test("commit is skipped after a batch committed, and a failed ROLLBACK is reported", async () => {
    const sender = heldSender({ ROLLBACK: new Error("connection lost") });
    const committedInBatch = transactionHandle(sender.send);
    const batch = committedInBatch.transaction.batch([statement("SELECT 1")], { commit: true });
    sender.releaseAll();
    await batch;
    await committedInBatch.commit();
    await expect(committedInBatch.rollback()).resolves.toBe(true);
    expect(sender.sent.map((item) => item.sql)).toEqual(["SELECT 1", "COMMIT"]);

    const failing = transactionHandle(sender.send);
    const query = failing.transaction.query("SELECT 2");
    sender.releaseAll();
    await query;
    const rollback = failing.rollback();
    sender.releaseAll();
    await expect(rollback).resolves.toBe(false);
  });

  test("post-commit effects run in order, once, and survive an effect that throws", () => {
    const handle = transactionHandle(heldSender().send);
    const effects: string[] = [];
    handle.transaction.afterCommit(() => effects.push("first"));
    handle.transaction.afterCommit(() => {
      throw new Error("an effect cannot undo a commit");
    });
    handle.transaction.afterCommit(() => effects.push("second"));

    handle.committed();
    handle.committed();
    expect(effects).toEqual(["first", "second"]);
  });
});

describe("managedTransactionDatabase over PGlite", () => {
  test("modes come first, setup runs before the callback, and effects follow COMMIT only", async () => {
    const postgres = new PGlite();
    try {
      await postgres.exec("CREATE TABLE notes (id integer PRIMARY KEY)");
      const observed: string[] = [];
      const database = managedTransactionDatabase(postgres, {
        initialize: (transaction) => transaction.setLocal({ "lore.marker": "set" }),
        observe: (sql) => observed.push(sql),
      });
      const effects: string[] = [];

      await expect(
        database.transaction(
          async (transaction) => {
            transaction.afterCommit(() => effects.push("committed"));
            const [state] = await transaction.batch([
              statement<{ isolation: string; marker: string }>(
                "SELECT current_setting('transaction_isolation') AS isolation, current_setting('lore.marker') AS marker",
              ),
            ]);
            expect(effects).toEqual([]);
            return state.rows;
          },
          { isolation: "repeatable read" },
        ),
      ).resolves.toEqual([{ isolation: "repeatable read", marker: "set" }]);
      expect(observed).toEqual([
        `SET TRANSACTION ${transactionModes({ isolation: "repeatable read" })}`,
        "SELECT set_config($1, $2, true)",
        expect.stringContaining("transaction_isolation"),
      ]);
      expect(effects).toEqual(["committed"]);

      await expect(
        database.transaction(async (transaction) => {
          transaction.afterCommit(() => effects.push("rolled back"));
          await transaction.query("INSERT INTO notes VALUES (1)");
          throw new Error("domain operation failed");
        }),
      ).rejects.toThrow("domain operation failed");
      expect(effects).toEqual(["committed"]);
      await expect(
        postgres.query("SELECT count(*)::int AS count FROM notes"),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await postgres.close();
    }
  });

  test("effects still run when the callback throws after a batch committed", async () => {
    const postgres = new PGlite();
    try {
      await postgres.exec("CREATE TABLE notes (id integer PRIMARY KEY)");
      const database = managedTransactionDatabase(postgres);
      const effects: string[] = [];
      const failure = new Error("failed after its commit");

      await expect(
        database.transaction(async (transaction) => {
          transaction.afterCommit(() => effects.push("committed"));
          await transaction.batch([statement("INSERT INTO notes VALUES (1)")], { commit: true });
          throw failure;
        }),
      ).rejects.toBe(failure);

      expect(effects).toEqual(["committed"]);
      await expect(
        postgres.query("SELECT count(*)::int AS count FROM notes"),
      ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      await postgres.close();
    }
  });

  test("a view through transactionThrough sees batched statements one by one", async () => {
    const postgres = new PGlite();
    try {
      const base = managedTransactionDatabase(postgres);
      const seen: string[] = [];
      const effects: string[] = [];
      const observed: PostgresDatabase = {
        transaction: (use, options) =>
          base.transaction(
            (transaction) =>
              use(
                transactionThrough(transaction, (sql, params) => {
                  seen.push(sql);
                  return transaction.query(sql, params);
                }),
              ),
            options,
          ),
      };

      const [one, two] = await observed.transaction((transaction) => {
        transaction.afterCommit(() => effects.push("committed"));
        return transaction.batch(
          [statement<{ n: number }>("SELECT 1 AS n"), statement<{ n: number }>("SELECT 2 AS n")],
          { commit: true },
        );
      });

      expect([one.rows, two.rows]).toEqual([[{ n: 1 }], [{ n: 2 }]]);
      expect(seen).toEqual(["SELECT 1 AS n", "SELECT 2 AS n"]);
      expect(effects).toEqual(["committed"]);
    } finally {
      await postgres.close();
    }
  });
});

/**
 * A connection adapter like a host's: BEGIN with the first statement, COMMIT unless
 * a batch sent it. It counts statements and network waits; a wait begins whenever a
 * statement goes out while nothing else is in flight, which is what pipelining saves.
 */
function measuredDatabase(postgres: PGlite) {
  const counts = { statements: 0, waits: 0 };
  let inFlight = 0;
  const send: PostgresSend = async (sql, params) => {
    counts.statements += 1;
    if (inFlight === 0) counts.waits += 1;
    inFlight += 1;
    try {
      return await postgres.query(sql, [...params]);
    } finally {
      inFlight -= 1;
    }
  };
  const database: PostgresDatabase = {
    async transaction(use, options) {
      const modes = transactionModes(options);
      const handle = transactionHandle(send, {
        opening: statement(modes ? `BEGIN ${modes}` : "BEGIN"),
      });
      try {
        const result = await use(handle.transaction);
        await handle.commit();
        handle.committed();
        return result;
      } catch (error) {
        await handle.rollback();
        throw error;
      }
    },
  };
  return {
    database,
    /** Statements and waits `operation` costs. */
    async measure(operation: () => Promise<unknown>) {
      counts.statements = 0;
      counts.waits = 0;
      await operation();
      return { ...counts };
    },
  };
}

test("engine operations stay within their statement and network-wait budgets", async () => {
  const postgres = new PGlite({ extensions: { vector } });
  try {
    await postgres.exec(
      await readFile(new URL("fixtures/independent-host-schema.sql", import.meta.url), "utf8"),
    );
    const measured = measuredDatabase(postgres);
    const storage: MemoryStorageContext = {
      database: measured.database,
      partitionId: "20000000-0000-4000-8000-000000000001",
      ownerId: "10000000-0000-4000-8000-000000000001",
    };
    const memories = createMemoryModule(storage, { embeddingDimensions: 8 });
    const graph = createMemoryGraphModule(storage);
    let first = { id: "", version: 0, content: "" };
    let second = { id: "", version: 0 };

    const budgets = {
      remember: await measured.measure(async () => {
        first = await memories.remember({ content: "Harbor observatory opens at dawn." });
      }),
      retrieve: await measured.measure(() => memories.retrieve(first.id)),
      list: await measured.measure(() => memories.list()),
      search: await measured.measure(() => memories.search({ query: "harbor observatory" })),
      update: await measured.measure(async () => {
        const updated = await memories.update(
          first.id,
          { content: "Harbor observatory opens at midnight." },
          { expectedVersion: first.version },
        );
        if (updated) first = updated;
      }),
      unchangedUpdate: await measured.measure(async () => {
        const unchanged = await memories.update(
          first.id,
          { content: first.content, scope: "shared" },
          { expectedVersion: first.version },
        );
        expect(unchanged?.version).toBe(first.version);
      }),
      scopeUpdate: await measured.measure(async () => {
        const updated = await memories.update(
          first.id,
          { scope: "private" },
          { expectedVersion: first.version },
        );
        if (updated) first = updated;
      }),
      connect: await measured.measure(async () => {
        second = await memories.remember({ content: "The midnight shift logs the tides." });
        const linked = await graph.connect({ sourceMemoryId: first.id, targetMemoryId: second.id });
        expect(linked).toMatchObject({ created: true });
      }),
      replaceLink: await measured.measure(() =>
        graph.connect({ sourceMemoryId: first.id, targetMemoryId: second.id, weight: 0.5 }),
      ),
      listLinks: await measured.measure(() => graph.list({ memoryId: first.id })),
      graph: await measured.measure(() => graph.read()),
      disconnect: await measured.measure(() =>
        graph.disconnect({ sourceMemoryId: first.id, targetMemoryId: second.id }),
      ),
      forget: await measured.measure(() =>
        memories.forget(first.id, { expectedVersion: first.version }),
      ),
    };

    expect(budgets).toEqual({
      remember: { statements: 4, waits: 1 },
      retrieve: { statements: 3, waits: 1 },
      list: { statements: 3, waits: 1 },
      search: { statements: 3, waits: 1 },
      // The lock with the stored-chunk read, then the update, the one replaced
      // chunk's delete and insert, and COMMIT.
      update: { statements: 7, waits: 2 },
      // Nothing differs: the lock with the stored-chunk read, then COMMIT alone.
      unchangedUpdate: { statements: 4, waits: 2 },
      // Scope alone never touches chunks: the lock, then the update with COMMIT.
      scopeUpdate: { statements: 4, waits: 2 },
      // A second remember (1 wait) and the Link: the lock with the existing-Link read,
      // then the counts and insert with COMMIT.
      connect: { statements: 9, waits: 3 },
      replaceLink: { statements: 5, waits: 2 },
      listLinks: { statements: 4, waits: 1 },
      graph: { statements: 4, waits: 1 },
      disconnect: { statements: 4, waits: 1 },
      // The delete and, under an expected version, the locking version read.
      forget: { statements: 4, waits: 1 },
    });
  } finally {
    await postgres.close();
  }
});
