import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, onTestFinished, test } from "vitest";
import {
  inspectMigrationHistory,
  migrationFiles,
  prepareDbmateHistory,
} from "../scripts/lib/migration-preflight.mjs";

const baselineUrl = new URL("../db/migrations/0001_v1_baseline.sql", import.meta.url);

async function database() {
  const postgres = new PGlite({ extensions: { vector } });
  await postgres.waitReady;
  onTestFinished(() => postgres.close());
  return postgres;
}

test("prepares and verifies the greenfield dbmate ledger", async () => {
  const postgres = await database();
  const migrations = await migrationFiles();
  const baseline = migrations[0];
  if (!baseline) throw new Error("v1 baseline migration is missing");
  await expect(inspectMigrationHistory(postgres, migrations)).resolves.toMatchObject({
    kind: "fresh",
    ok: true,
  });

  await prepareDbmateHistory(postgres, migrations);
  await postgres.exec(await readFile(baselineUrl, "utf8"));
  await postgres.query("INSERT INTO lore_schema_migrations (version, checksum) VALUES ($1, $2)", [
    baseline.version,
    baseline.checksum,
  ]);

  await expect(inspectMigrationHistory(postgres, migrations)).resolves.toMatchObject({
    kind: "dbmate",
    ok: true,
    revision: 1,
    versions: ["0001"],
  });
});

test("rejects a Lore schema without the current dbmate ledger", async () => {
  const postgres = await database();
  await postgres.exec(await readFile(baselineUrl, "utf8"));

  const migrations = await migrationFiles();
  await expect(inspectMigrationHistory(postgres, migrations)).resolves.toMatchObject({
    kind: "invalid",
    ok: false,
    detail: "Lore schema exists without a recognized migration ledger",
  });
  await expect(prepareDbmateHistory(postgres, migrations)).rejects.toThrow(
    "Lore schema exists without a recognized migration ledger",
  );
});

test("rejects a modified v1 baseline checksum", async () => {
  const postgres = await database();
  await postgres.exec(await readFile(baselineUrl, "utf8"));
  await postgres.exec(`
    CREATE TABLE lore_schema_migrations (
      version varchar(255) PRIMARY KEY,
      checksum text
    );
    INSERT INTO lore_schema_migrations (version, checksum) VALUES ('0001', 'modified');
  `);

  await expect(inspectMigrationHistory(postgres, await migrationFiles())).resolves.toMatchObject({
    kind: "dbmate",
    ok: false,
    detail: expect.stringContaining("modified:0001"),
  });
});
