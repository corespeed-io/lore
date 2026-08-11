import { describe, expect, test } from "vitest";
import {
  hasCompleteLegacyBaseline,
  LEGACY_BASELINE_MIGRATIONS,
  PRE_DBMATE_MIGRATIONS,
  preDbmateAdoption,
} from "../scripts/migration-baseline.mjs";

const completeLegacyHistory = [...LEGACY_BASELINE_MIGRATIONS].map(([id, checksum]) => ({
  id,
  checksum,
}));

describe("squashed migration baseline", () => {
  test("leaves fresh databases alone", () => {
    expect(hasCompleteLegacyBaseline([])).toBe(false);
  });

  test("recognizes the exact complete legacy history", () => {
    expect(hasCompleteLegacyBaseline(completeLegacyHistory)).toBe(true);
  });

  test("rejects a partial legacy history", () => {
    expect(() => hasCompleteLegacyBaseline(completeLegacyHistory.slice(0, -1))).toThrow(
      "found 12 of 13 migrations",
    );
  });

  test("rejects modified legacy SQL", () => {
    const modifiedHistory = completeLegacyHistory.map((migration, index) =>
      index === 0 ? { ...migration, checksum: "modified" } : migration,
    );

    expect(() => hasCompleteLegacyBaseline(modifiedHistory)).toThrow(
      "migration 0001_memory.sql was modified",
    );
  });
});

describe("data-preserving dbmate adoption", () => {
  test("adopts an exact pre-dbmate prefix as dbmate versions", () => {
    const rows = [...PRE_DBMATE_MIGRATIONS].slice(0, 4).map(([id, checksum]) => ({ id, checksum }));
    expect(preDbmateAdoption(rows)).toEqual({
      kind: "pre-dbmate",
      versions: ["0001", "0002", "0003", "0004"],
    });
  });

  test("rejects a pre-dbmate history gap", () => {
    const rows = [...PRE_DBMATE_MIGRATIONS]
      .filter(([id]) => !id.startsWith("0002"))
      .map(([id, checksum]) => ({ id, checksum }));
    expect(() => preDbmateAdoption(rows)).toThrow("missing migration 0002");
  });
});
