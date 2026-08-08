import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { LEGACY_BASELINE_MIGRATIONS } from "../scripts/migration-baseline.mjs";
import { migrationHistoryStatus } from "../scripts/lib/migration-preflight.mjs";

const currentMigrations = [{ id: "0001_initial.sql", checksum: "current" }];

test("migration preflight permits the exact legacy history that migrate can adopt", () => {
  const applied = [...LEGACY_BASELINE_MIGRATIONS].map(([id, checksum]) => ({ id, checksum }));
  expect(migrationHistoryStatus(applied, currentMigrations)).toEqual({
    modified: [],
    unknown: [],
  });
});

test("migration preflight still rejects extra history beside an adoptable legacy baseline", () => {
  const applied = [
    ...[...LEGACY_BASELINE_MIGRATIONS].map(([id, checksum]) => ({ id, checksum })),
    {
      id: "0099_unknown.sql",
      checksum: createHash("sha256").update("unknown").digest("hex"),
    },
  ];
  expect(migrationHistoryStatus(applied, currentMigrations).unknown).toEqual([applied.at(-1)]);
});
