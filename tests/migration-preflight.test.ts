import { expect, test } from "vitest";
import { drizzleHistoryIssues } from "../scripts/lib/drizzle-migrations";

const expected = [
  { folderMillis: 1, hash: "one", sql: ["one"], bps: true },
  { folderMillis: 2, hash: "two", sql: ["two"], bps: true },
  { folderMillis: 3, hash: "three", sql: ["three"], bps: true },
];

test("Drizzle preflight accepts a fresh database and exact journal", () => {
  expect(drizzleHistoryIssues([], expected)).toEqual([]);
  expect(
    drizzleHistoryIssues(
      expected.map((migration) => ({
        created_at: migration.folderMillis,
        hash: migration.hash,
      })),
      expected,
    ),
  ).toEqual([]);
});

test("Drizzle preflight rejects modified and unknown journal records", () => {
  expect(
    drizzleHistoryIssues(
      [
        { created_at: 1, hash: "modified" },
        { created_at: 99, hash: "unknown" },
      ],
      expected,
    ),
  ).toEqual([
    { id: "1", reason: "modified" },
    { id: "99", reason: "unknown" },
  ]);
});

test("Drizzle preflight rejects gaps before the highest applied migration", () => {
  expect(
    drizzleHistoryIssues(
      [
        { created_at: 1, hash: "one" },
        { created_at: 3, hash: "three" },
      ],
      expected,
    ),
  ).toEqual([{ id: "2", reason: "missing" }]);
});
