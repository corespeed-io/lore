import { type PostgresTransaction, statement } from "@corespeed/lore-core";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createPostgresDatabase,
  createRequestPostgresDatabase,
  postgresPipeline,
} from "@/server/database/postgres";

// Replace only pg's socket lifecycle; PostgreSQL executes the transaction and RLS
// statements so omitted setup or leaked roles change the visible rows.
const driver = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  poolConfig: vi.fn(),
  poolEnd: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: class {
    constructor(config: unknown) {
      driver.poolConfig(config);
    }

    on() {
      return this;
    }

    async connect() {
      return { query: driver.query, release: driver.release };
    }

    async end() {
      driver.poolEnd();
    }
  },
}));

let postgres: PGlite;
let sent: string[];

beforeEach(async () => {
  vi.clearAllMocks();
  sent = [];
  postgres = new PGlite();
  await postgres.exec(`
    CREATE ROLE lore_app NOLOGIN;
    CREATE ROLE lore_maintenance NOLOGIN;
    CREATE TABLE role_evidence (id text PRIMARY KEY, visible_to name NOT NULL);
    INSERT INTO role_evidence VALUES ('request', 'lore_app'), ('maintenance', 'lore_maintenance');
    ALTER TABLE role_evidence ENABLE ROW LEVEL SECURITY;
    GRANT SELECT, INSERT ON role_evidence TO lore_app, lore_maintenance;
    CREATE POLICY visible_role ON role_evidence USING (visible_to = current_user);
  `);
  driver.query.mockImplementation((sql: string, params: unknown[] = []) => {
    sent.push(sql);
    return postgres.query(sql, params);
  });
});

afterEach(async () => {
  await postgres.close();
});

const adapters = [
  { name: "process pool", create: createPostgresDatabase },
  { name: "request pool", create: createRequestPostgresDatabase },
];

async function currentUser(): Promise<string | undefined> {
  const result = await postgres.query<{ name: string }>("SELECT current_user AS name");
  return result.rows[0]?.name;
}

test.each(adapters)(
  "$name transactions run as their role and reset it at COMMIT and ROLLBACK",
  async ({ create }) => {
    const request = create({});
    const maintenance = create({}, { role: "lore_maintenance" });

    await expect(
      request.transaction((transaction) => transaction.query("SELECT id FROM role_evidence")),
    ).resolves.toEqual({ rows: [{ id: "request" }] });
    await expect(currentUser()).resolves.toBe("postgres");
    await expect(
      maintenance.transaction((transaction) => transaction.query("SELECT id FROM role_evidence")),
    ).resolves.toEqual({ rows: [{ id: "maintenance" }] });

    const failure = new Error("domain operation failed");
    await expect(
      request.transaction(async (transaction) => {
        await transaction.query("INSERT INTO role_evidence VALUES ('rolled back', 'lore_app')");
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(currentUser()).resolves.toBe("postgres");
    await expect(
      postgres.query("SELECT count(*)::int AS count FROM role_evidence"),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });

    // A healthy connection goes back to the pool after both outcomes.
    expect(driver.release.mock.calls).toEqual([[undefined], [undefined], [undefined]]);
    await Promise.all([request.close(), maintenance.close()]);
  },
);

test.each(adapters)(
  "$name opens with BEGIN and the role in front of the first statement",
  async ({ create }) => {
    const database = create({});

    await database.transaction((transaction) => transaction.query("SELECT 1"));

    expect(sent).toEqual(["BEGIN", "SELECT set_config($1, $2, true)", "SELECT 1", "COMMIT"]);
    expect(driver.query.mock.calls[1]?.[1]).toEqual(["role", "lore_app"]);
    await database.close();
  },
);

test.each(adapters)(
  "$name starts a transaction in the requested modes before the role is set",
  async ({ create }) => {
    const database = create({});
    const modes = (transaction: PostgresTransaction) =>
      transaction.query(
        "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only",
      );

    await expect(
      database.transaction(modes, { isolation: "repeatable read", readOnly: true }),
    ).resolves.toEqual({ rows: [{ isolation: "repeatable read", read_only: "on" }] });
    expect(sent[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await expect(database.transaction(modes)).resolves.toEqual({
      rows: [{ isolation: "read committed", read_only: "off" }],
    });
    await expect(
      database.transaction(
        (transaction) => transaction.query("INSERT INTO role_evidence VALUES ('x', 'lore_app')"),
        { readOnly: true },
      ),
    ).rejects.toThrow(/read-only transaction/);
    await database.close();
  },
);

test.each(adapters)(
  "$name never sends a transaction that runs no statement",
  async ({ create }) => {
    const database = create({});

    await expect(database.transaction(async () => "nothing to do")).resolves.toBe("nothing to do");
    await expect(
      database.transaction(async () => {
        throw new Error("refused before any statement");
      }),
    ).rejects.toThrow("refused before any statement");

    expect(sent).toEqual([]);
    expect(driver.release).toHaveBeenCalledTimes(2);
    await database.close();
  },
);

test.each(adapters)(
  "$name destroys a connection whose ROLLBACK failed instead of reusing it",
  async ({ create }) => {
    const database = create({});
    driver.query.mockImplementation((sql: string, params: unknown[] = []) => {
      sent.push(sql);
      if (sql === "ROLLBACK") return Promise.reject(new Error("connection lost"));
      return postgres.query(sql, params);
    });
    const failure = new Error("domain operation failed");

    await expect(
      database.transaction(async (transaction) => {
        await transaction.query("SELECT 1");
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(driver.release.mock.calls).toEqual([[true]]);
    await postgres.query("ROLLBACK");
    await database.close();
  },
);

test.each(adapters)(
  "$name runs post-commit effects only after COMMIT succeeds",
  async ({ create }) => {
    const database = create({});
    const effects: string[] = [];

    await database.transaction(async (transaction) => {
      transaction.afterCommit(() => effects.push(`first after ${sent.at(-1)}`));
      transaction.afterCommit(() => {
        throw new Error("an effect cannot undo a commit");
      });
      transaction.afterCommit(() => effects.push("second"));
      await transaction.query("SELECT 1");
      expect(effects).toEqual([]);
    });
    await expect(
      database.transaction(async (transaction) => {
        transaction.afterCommit(() => effects.push("rolled back"));
        await transaction.query("SELECT 1");
        throw new Error("domain operation failed");
      }),
    ).rejects.toThrow("domain operation failed");

    expect(effects).toEqual(["first after COMMIT", "second"]);
    await database.close();
  },
);

test.each(adapters)(
  "$name commits inside a batch and reports the first failure in statement order",
  async ({ create }) => {
    const database = create({});

    const [first, second] = await database.transaction((transaction) =>
      transaction.batch(
        [
          statement<{ id: string }>(
            "INSERT INTO role_evidence VALUES ('batched', 'lore_app') RETURNING id",
          ),
          statement<{ count: number }>("SELECT count(*)::int AS count FROM role_evidence"),
        ],
        { commit: true },
      ),
    );
    expect(first.rows).toEqual([{ id: "batched" }]);
    // The second statement's snapshot sees the first statement's row.
    expect(second.rows).toEqual([{ count: 2 }]);
    expect(sent.slice(-1)).toEqual(["COMMIT"]);
    expect(sent.filter((sql) => sql === "COMMIT")).toHaveLength(1);

    await expect(
      database.transaction((transaction) =>
        transaction.batch([
          statement("INSERT INTO role_evidence VALUES ('never', 'lore_app')"),
          statement("SELECT * FROM missing_table"),
          statement("SELECT * FROM another_missing_table"),
        ]),
      ),
    ).rejects.toThrow("missing_table");
    await expect(
      postgres.query("SELECT count(*)::int AS count FROM role_evidence WHERE id = 'never'"),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await database.close();
  },
);

test("a pipelined batch sends every statement before the first result arrives", async () => {
  const database = createPostgresDatabase({});
  const gate = Promise.withResolvers<void>();
  driver.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    sent.push(sql);
    await gate.promise;
    return postgres.query(sql, params);
  });

  const pending = database.transaction((transaction) =>
    transaction.batch(
      [statement("SELECT 1 AS one"), statement("SELECT 2 AS two"), statement("SELECT 3 AS three")],
      { commit: true },
    ),
  );
  await vi.waitFor(() => expect(sent).toHaveLength(6));

  expect(sent).toEqual([
    "BEGIN",
    "SELECT set_config($1, $2, true)",
    "SELECT 1 AS one",
    "SELECT 2 AS two",
    "SELECT 3 AS three",
    "COMMIT",
  ]);
  gate.resolve();
  await expect(pending).resolves.toEqual([
    { rows: [{ one: 1 }] },
    { rows: [{ two: 2 }] },
    { rows: [{ three: 3 }] },
  ]);
  await database.close();
});

test("settings set together travel in one statement, the latest value winning", async () => {
  const database = createPostgresDatabase({});

  await expect(
    database.transaction(async (transaction) => {
      transaction.setLocal({ "lore.workspace_id": "first", "lore.user_id": "alice" });
      transaction.setLocal({ "lore.workspace_id": "second" });
      return transaction.query(
        "SELECT current_setting('lore.workspace_id') AS workspace, current_setting('lore.user_id') AS user_id, current_user AS role",
      );
    }),
  ).resolves.toEqual({ rows: [{ workspace: "second", user_id: "alice", role: "lore_app" }] });

  expect(sent).toHaveLength(4);
  expect(sent[1]).toBe(
    "SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true)",
  );
  expect(driver.query.mock.calls[1]?.[1]).toEqual([
    "role",
    "lore_app",
    "lore.workspace_id",
    "second",
    "lore.user_id",
    "alice",
  ]);
  await database.close();
});

test("each adapter picks its pipelining default and accepts an explicit override", async () => {
  const processPool = createPostgresDatabase({ max: 4 });
  const requestPool = createRequestPostgresDatabase({ max: 10 }, { pipeline: true });

  expect(driver.poolConfig.mock.calls).toEqual([
    [{ max: 4, pipeline: true }],
    [{ max: 2, idleTimeoutMillis: 0, pipeline: true }],
  ]);
  expect(postgresPipeline("1", false)).toBe(true);
  expect(postgresPipeline("0", true)).toBe(false);
  expect(postgresPipeline(undefined, true)).toBe(true);
  expect(postgresPipeline("yes", false)).toBe(false);
  await Promise.all([processPool.close(), requestPool.close()]);
});

test("a request database refuses work once closed and closes its pool once", async () => {
  const database = createRequestPostgresDatabase({});

  await database.close();
  await database.close();

  await expect(
    database.transaction((transaction) => transaction.query("SELECT 1")),
  ).rejects.toThrow("The request database is closed");
  expect(driver.poolEnd).toHaveBeenCalledTimes(1);
  expect(sent).toEqual([]);
});
