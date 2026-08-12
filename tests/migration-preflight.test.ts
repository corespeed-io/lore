import { expect, test } from "vitest";
import {
  dbmateHistoryStatus,
  isSchemaRevisionSupported,
} from "../scripts/lib/migration-preflight.mjs";

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
