import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  archiveCommandCheck,
  archivedWalArtifactCheck,
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
  expect(archiveCommandCheck("/bin/true %p")).toMatchObject({ ok: false });
  expect(archiveCommandCheck("sh -c 'true' %p")).toMatchObject({ ok: false });
});

test("PITR checks require the latest WAL to exist as a non-empty archive artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lore-pitr-"));
  const walName = "000000010000000000000002";
  await expect(archivedWalArtifactCheck(directory, walName)).resolves.toMatchObject({ ok: false });
  await writeFile(join(directory, walName), "verified WAL bytes", { mode: 0o600 });
  await expect(archivedWalArtifactCheck(directory, walName)).resolves.toEqual({
    ok: true,
    detail: "latest WAL artifact exists (path redacted)",
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
