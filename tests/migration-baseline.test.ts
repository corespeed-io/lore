import { describe, expect, test } from "vitest";
import { LEGACY_CUTOVER_MIGRATIONS, legacyCutoverIssues } from "../scripts/lib/drizzle-migrations";

const completeLegacyHistory = [...LEGACY_CUTOVER_MIGRATIONS].map(([id, checksum]) => ({
  id,
  checksum,
}));

describe("Drizzle cutover baseline", () => {
  test("recognizes only the exact complete pre-cutover history", () => {
    expect(legacyCutoverIssues(completeLegacyHistory)).toEqual([]);
  });

  test("rejects a partial legacy history", () => {
    expect(legacyCutoverIssues(completeLegacyHistory.slice(0, -1))).toContainEqual({
      id: "0009_observation_evidence.sql",
      reason: "missing",
    });
  });

  test("rejects modified legacy SQL", () => {
    const modified = completeLegacyHistory.map((migration, index) =>
      index === 0 ? { ...migration, checksum: "modified" } : migration,
    );
    expect(legacyCutoverIssues(modified)).toContainEqual({
      id: "0001_initial.sql",
      reason: "modified",
    });
  });

  test("rejects unknown history instead of guessing schema state", () => {
    expect(
      legacyCutoverIssues([
        ...completeLegacyHistory,
        { id: "0099_unknown.sql", checksum: "unknown" },
      ]),
    ).toContainEqual({ id: "0099_unknown.sql", reason: "unknown" });
  });
});
