import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";
import { LoreConfigurationError, type PostgresTransaction, transactionModes } from "../src/index";
import { testDatabase } from "../src/testing";

test("transaction modes spell each requested mode as BEGIN takes it, and nothing by default", () => {
  expect(transactionModes()).toBe("");
  expect(transactionModes({})).toBe("");
  expect(transactionModes({ readOnly: false })).toBe("");
  expect(transactionModes({ isolation: "serializable" })).toBe("ISOLATION LEVEL SERIALIZABLE");
  expect(transactionModes({ readOnly: true })).toBe("READ ONLY");
  expect(transactionModes({ isolation: "repeatable read", readOnly: true })).toBe(
    "ISOLATION LEVEL REPEATABLE READ, READ ONLY",
  );
});

test("transaction modes refuse an isolation level they do not name, so its text never reaches SQL", () => {
  for (const isolation of ["read committed; SELECT 1", "Serializable", "constructor", ""]) {
    expect(() => transactionModes({ isolation: isolation as "serializable" })).toThrow(
      LoreConfigurationError,
    );
  }
});

test("the schema kit's test database starts the modes before host setup that reads", async () => {
  const postgres = new PGlite();
  try {
    await postgres.exec("CREATE TABLE host_state (id integer PRIMARY KEY)");
    // Setup that reads takes the snapshot, after which PostgreSQL refuses to change
    // the isolation level, so the modes must come first.
    const database = testDatabase(postgres, async (transaction) => {
      await transaction.query("SELECT id FROM host_state");
    });
    const modes = (transaction: PostgresTransaction) =>
      transaction.query<{ isolation: string; read_only: string }>(
        "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only",
      );

    await expect(
      database.transaction(modes, { isolation: "serializable", readOnly: true }),
    ).resolves.toMatchObject({ rows: [{ isolation: "serializable", read_only: "on" }] });
    await expect(database.transaction(modes)).resolves.toMatchObject({
      rows: [{ isolation: "read committed", read_only: "off" }],
    });
    await expect(
      database.transaction(
        (transaction) => transaction.query("INSERT INTO host_state VALUES (1)"),
        {
          readOnly: true,
        },
      ),
    ).rejects.toThrow(/read-only transaction/);
  } finally {
    await postgres.close();
  }
});
