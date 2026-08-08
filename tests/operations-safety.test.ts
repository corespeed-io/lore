import { expect, test } from "vitest";
import {
  archiveCommandCheck,
  archivedWalCheck,
  restoreDrillCheck,
} from "../scripts/lib/pitr-check.mjs";

test("PITR checks reject no-op commands without exposing their value", () => {
  expect(archiveCommandCheck("true")).toEqual({
    ok: false,
    detail: "unsafe or missing %p WAL path placeholder",
  });
  expect(archiveCommandCheck("secret-uploader --token super-secret %p")).toEqual({
    ok: true,
    detail: "configured (redacted)",
  });
});

test("PITR checks require observed archive progress and a recent restore drill", () => {
  expect(
    archivedWalCheck({ archived_count: 0, failed_count: 0, last_archived_wal: null }),
  ).toMatchObject({ ok: false });
  expect(
    archivedWalCheck({
      archived_count: 2,
      last_archived_wal: "000000010000000000000002",
      last_archived_time: "2026-08-07T12:00:00Z",
      last_failed_time: "2026-08-07T11:00:00Z",
    }),
  ).toMatchObject({ ok: true });
  expect(restoreDrillCheck("2026-08-01T12:00:00Z", new Date("2026-08-07T12:00:00Z"))).toMatchObject(
    { ok: true },
  );
  expect(restoreDrillCheck("2025-01-01T00:00:00Z", new Date("2026-08-07T12:00:00Z"))).toMatchObject(
    { ok: false },
  );
});
