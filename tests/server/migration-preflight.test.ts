import { expect, test } from "vitest";
import {
  dbmateHistoryStatus,
  isSchemaRevisionSupported,
  type MigrationFile,
  migrationFiles,
  pendingMigrationSteps,
} from "../../scripts/database/lib/migration-preflight.ts";
import {
  migrationQueries,
  parseMigration,
  splitMigrationStatements,
} from "../../scripts/database/lib/migration-statements.ts";

const migrations = [
  { version: "0001", checksum: "one" },
  { version: "0002", checksum: "two" },
  { version: "0003", checksum: "three" },
];

test("dbmate preflight accepts an exact checksum-protected prefix", () => {
  expect(
    dbmateHistoryStatus(
      [
        { version: "0001", checksum: "one" },
        { version: "0002", checksum: "two" },
      ],
      migrations,
    ),
  ).toEqual({ missing: [], modified: [], unknown: [] });
});

test("dbmate preflight rejects missing or modified checksums", () => {
  const applied = [
    { version: "0001", checksum: null },
    { version: "0003", checksum: "modified" },
  ];
  expect(dbmateHistoryStatus(applied, migrations)).toEqual({
    missing: ["0002"],
    modified: applied,
    unknown: [],
  });
});

test("dbmate preflight rejects unknown versions", () => {
  const unknown = { version: "0099", checksum: "unknown" };
  expect(dbmateHistoryStatus([unknown], migrations).unknown).toEqual([unknown]);
});

test("schema compatibility permits the next migration to upgrade an older database", () => {
  expect(isSchemaRevisionSupported(1, 2)).toBe(true);
  expect(isSchemaRevisionSupported(2, 2)).toBe(true);
  expect(isSchemaRevisionSupported(3, 2)).toBe(false);
  expect(isSchemaRevisionSupported(0, 2)).toBe(false);
});

test("migration parsing reads dbmate's transaction option and rejects the unexpected", () => {
  expect(parseMigration("-- migrate:up\nSELECT 1;\n-- migrate:down\n", "a")).toEqual({
    transaction: true,
    up: "-- migrate:up\nSELECT 1;\n",
  });
  expect(
    parseMigration("-- note\n\n-- migrate:up transaction:false\nSELECT 1;\n-- migrate:down\n", "b"),
  ).toMatchObject({ transaction: false });
  expect(() => parseMigration("-- migrate:up retries:3\n-- migrate:down\n", "c")).toThrow(
    "unsupported migrate:up option retries:3",
  );
  expect(() => parseMigration("SELECT 1;\n-- migrate:up\n-- migrate:down\n", "d")).toThrow(
    "SQL before its -- migrate:up",
  );
  expect(() => parseMigration("-- migrate:down\n-- migrate:up\n", "e")).toThrow(
    "one -- migrate:up directive before one -- migrate:down",
  );
});

test("transaction:false statements split only at line-ending semicolons outside comments", () => {
  expect(
    splitMigrationStatements(
      [
        "-- migrate:up transaction:false",
        "-- a comment that ends like a statement;",
        "DROP INDEX CONCURRENTLY IF EXISTS public.a; ",
        "UPDATE public.lore_system_state",
        "SET schema_revision = 5 -- inline; not a terminator",
        "WHERE singleton;",
        "-- trailing comment only",
        "",
      ].join("\n"),
      "f",
    ),
  ).toEqual([
    [
      "-- migrate:up transaction:false",
      "-- a comment that ends like a statement;",
      "DROP INDEX CONCURRENTLY IF EXISTS public.a; ",
    ].join("\n"),
    [
      "UPDATE public.lore_system_state",
      "SET schema_revision = 5 -- inline; not a terminator",
      "WHERE singleton;",
    ].join("\n"),
  ]);
  expect(() => splitMigrationStatements("SELECT 1;\nSELECT 2\n", "g")).toThrow(
    "no terminating semicolon",
  );
  expect(() => splitMigrationStatements("DO $$ BEGIN PERFORM 1;\nEND $$;\n", "h")).toThrow(
    "dollar-quoted body",
  );
});

test("the chain sends 0005 one statement at a time and every other migration whole", async () => {
  for (const migration of await migrationFiles()) {
    const queries = migrationQueries(migration.sql, migration.id);
    if (migration.version !== "0005") {
      expect(queries, migration.id).toHaveLength(1);
      continue;
    }
    // Six DROP/CREATE CONCURRENTLY pairs, then the schema revision last.
    expect(queries).toHaveLength(13);
    expect(queries.slice(0, 12).every((query) => /CONCURRENTLY/.test(query))).toBe(true);
    expect(queries.at(-1)).toMatch(/^UPDATE public\.lore_system_state\s+SET schema_revision = 5,/m);
  }
});

test("db:migrate hands dbmate each transactional run and applies transaction:false files itself", () => {
  const file = (version: string, transactional: boolean): MigrationFile => ({
    id: `${version}_step.sql`,
    version,
    sql: `-- migrate:up${transactional ? "" : " transaction:false"}\nSELECT 1;\n-- migrate:down\n`,
    checksum: version,
  });
  const chain = [
    file("0001", true),
    file("0002", true),
    file("0003", false),
    file("0004", true),
    file("0005", false),
    file("0006", false),
  ];
  const steps = (applied: string[]) =>
    pendingMigrationSteps(applied, chain).map((step) =>
      step.kind === "dbmate"
        ? `dbmate→${step.through.version}`
        : `direct:${step.migration.version}`,
    );

  expect(steps([])).toEqual([
    "dbmate→0002",
    "direct:0003",
    "dbmate→0004",
    "direct:0005",
    "direct:0006",
  ]);
  expect(steps(["0001", "0002", "0003"])).toEqual(["dbmate→0004", "direct:0005", "direct:0006"]);
  expect(steps(["0001", "0002", "0003", "0004", "0005", "0006"])).toEqual([]);
});
