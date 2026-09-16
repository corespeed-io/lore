import {
  createPostgresDatabase as createCorePostgresDatabase,
  createRequestPostgresDatabase as createCoreRequestPostgresDatabase,
} from "@corespeed/lore-core/postgres";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createPostgresDatabase, createRequestPostgresDatabase } from "@/server/database/postgres";

// Replace only pg's socket lifecycle; PostgreSQL executes the transaction and RLS
// statements so omitted setup or leaked roles change the visible rows.
const driver = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  poolEnd: vi.fn(),
  clientConnect: vi.fn(),
  clientEnd: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: class {
    async connect() {
      return { query: driver.query, release: driver.release };
    }

    async end() {
      driver.poolEnd();
    }
  },
  Client: class {
    query = driver.query;

    async connect() {
      driver.clientConnect();
    }

    async end() {
      driver.clientEnd();
    }
  },
}));

let postgres: PGlite;

beforeEach(async () => {
  vi.clearAllMocks();
  postgres = new PGlite();
  await postgres.exec(`
    CREATE ROLE lore_app NOLOGIN;
    CREATE ROLE lore_maintenance NOLOGIN;
    CREATE ROLE host_reader NOLOGIN;
    CREATE TABLE role_evidence (id text PRIMARY KEY, visible_to name NOT NULL);
    INSERT INTO role_evidence VALUES
      ('request', 'lore_app'), ('maintenance', 'lore_maintenance'), ('host', 'host_reader');
    ALTER TABLE role_evidence ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON role_evidence TO lore_app, lore_maintenance, host_reader;
    CREATE POLICY visible_role ON role_evidence FOR SELECT
      USING (visible_to = current_user);
  `);
  driver.query.mockImplementation((sql: string, params: unknown[] = []) =>
    postgres.query(sql, params),
  );
});

afterEach(async () => {
  await postgres.close();
});

const adapters = [
  {
    name: "pooled",
    createCore: createCorePostgresDatabase,
    createOss: createPostgresDatabase,
    released: driver.release,
  },
  {
    name: "per-transaction connection",
    createCore: createCoreRequestPostgresDatabase,
    createOss: createRequestPostgresDatabase,
    released: driver.clientEnd,
  },
];

test.each(adapters)(
  "$name OSS transactions enforce and reset request/maintenance roles",
  async ({ createCore, createOss, released }) => {
    const request = createOss({});
    const maintenance = createOss({}, { role: "lore_maintenance" });
    const core = createCore({});

    await expect(
      request.transaction((transaction) => transaction.query("SELECT id FROM role_evidence")),
    ).resolves.toEqual({ rows: [{ id: "request" }] });
    await expect(
      maintenance.transaction((transaction) => transaction.query("SELECT id FROM role_evidence")),
    ).resolves.toEqual({ rows: [{ id: "maintenance" }] });

    const failure = new Error("domain operation failed");
    await expect(
      request.transaction(async (transaction) => {
        expect(await transaction.query("SELECT id FROM role_evidence")).toEqual({
          rows: [{ id: "request" }],
        });
        throw failure;
      }),
    ).rejects.toBe(failure);

    // Reusing the same underlying database must not retain the prior local role.
    // With no host initializer the core adapter imposes no Lore access policy.
    await expect(
      core.transaction((transaction) =>
        transaction.query("SELECT id FROM role_evidence ORDER BY id"),
      ),
    ).resolves.toEqual({ rows: [{ id: "host" }, { id: "maintenance" }, { id: "request" }] });
    expect(released).toHaveBeenCalledTimes(4);

    await Promise.all([request.close(), maintenance.close(), core.close()]);
  },
);

test.each(adapters)(
  "$name initializes host policy before domain operations",
  async ({ createCore }) => {
    const database = createCore(
      {},
      {
        async initializeTransaction(transaction) {
          await transaction.query("SET LOCAL ROLE host_reader");
        },
      },
    );

    await expect(
      database.transaction((transaction) => transaction.query("SELECT id FROM role_evidence")),
    ).resolves.toEqual({ rows: [{ id: "host" }] });
    await expect(postgres.query("SELECT current_user AS name")).resolves.toMatchObject({
      rows: [{ name: "postgres" }],
    });
    await database.close();
  },
);

test.each(adapters)(
  "$name rolls back failed initialization without running domain operations",
  async ({ createCore, released }) => {
    const database = createCore(
      {},
      {
        async initializeTransaction(transaction) {
          await transaction.query("SET LOCAL ROLE host_reader");
          await transaction.query("SELECT * FROM missing_host_setup_table");
        },
      },
    );
    const use = vi.fn();

    await expect(database.transaction(use)).rejects.toThrow("missing_host_setup_table");
    expect(use).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledTimes(1);
    await expect(postgres.query("SELECT current_user AS name")).resolves.toMatchObject({
      rows: [{ name: "postgres" }],
    });
    // This query would fail if PostgreSQL were still in the aborted transaction.
    await expect(
      postgres.query("SELECT count(*)::int AS count FROM role_evidence"),
    ).resolves.toMatchObject({
      rows: [{ count: 3 }],
    });
    await database.close();
  },
);
