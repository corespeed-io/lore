import { describe, expect, test } from "vitest";
import {
  hasCompleteLegacyBaseline,
  LEGACY_BASELINE_MIGRATIONS,
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
      "found 12 of 13 legacy migrations",
    );
  });

  test("rejects modified legacy SQL", () => {
    const modifiedHistory = completeLegacyHistory.map((migration, index) =>
      index === 0 ? { ...migration, checksum: "modified" } : migration,
    );

    expect(() => hasCompleteLegacyBaseline(modifiedHistory)).toThrow(
      "legacy migration 0001_memory.sql was modified",
    );
  });
});
