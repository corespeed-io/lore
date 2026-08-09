import { expect, test } from "vitest";
import type { WorkspaceArchive } from "@/lib/portability";
import {
  parseWorkspaceArchiveText,
  workspaceArchiveFilename,
  workspaceArchiveSourceOwners,
  workspaceImportFingerprint,
  workspaceOwnerMap,
} from "@/lib/workspace-operations";

const ALICE_ID = "10000000-0000-4000-8000-000000000001";
const BOB_ID = "10000000-0000-4000-8000-000000000002";

function archive(): WorkspaceArchive {
  return {
    manifest: {
      checksum: "a".repeat(64),
      exportedAt: "2026-08-09T12:34:56.000Z",
      format: "lore-workspace-v1",
      memoryCount: 2,
      linkCount: 0,
      sourceDeploymentId: "20000000-0000-4000-8000-000000000001",
      sourceWorkspaceId: "30000000-0000-4000-8000-000000000001",
      visibility: "actor-visible",
    },
    memories: [
      {
        id: "40000000-0000-4000-8000-000000000001",
        ownerUserId: BOB_ID,
        scope: "shared",
        content: "Bob shared Memory.",
        metadata: {},
        version: 1,
        createdAt: "2026-08-09T12:00:00.000Z",
        updatedAt: "2026-08-09T12:00:00.000Z",
      },
      {
        id: "40000000-0000-4000-8000-000000000002",
        ownerUserId: ALICE_ID,
        scope: "private",
        content: "Alice private Memory.",
        metadata: {},
        version: 1,
        createdAt: "2026-08-09T12:01:00.000Z",
        updatedAt: "2026-08-09T12:01:00.000Z",
      },
    ],
    links: [],
  };
}

test("Workspace archive selection rejects malformed files before network import", () => {
  expect(() => parseWorkspaceArchiveText("not-json")).toThrow("not valid JSON");
  expect(() => parseWorkspaceArchiveText(JSON.stringify({ memories: [], links: [] }))).toThrow(
    "not a Lore Workspace archive",
  );

  const mismatched = archive();
  mismatched.manifest.memoryCount = 1;
  expect(() => parseWorkspaceArchiveText(JSON.stringify(mismatched))).toThrow(
    "counts do not match",
  );
});

test("Workspace owner remap maps every source owner to one verified target", () => {
  const selected = parseWorkspaceArchiveText(JSON.stringify(archive()));

  expect(workspaceArchiveSourceOwners(selected)).toEqual([ALICE_ID, BOB_ID]);
  expect(workspaceOwnerMap(selected, ALICE_ID.toUpperCase())).toEqual({
    [ALICE_ID]: ALICE_ID,
    [BOB_ID]: ALICE_ID,
  });
});

test("Workspace import dry-run fingerprints bind checksum, target owner, and collision policy", () => {
  const selected = archive();
  const remap = workspaceImportFingerprint(selected, ALICE_ID, "remap");

  expect(workspaceImportFingerprint(selected, ALICE_ID, "skip")).not.toBe(remap);
  expect(workspaceImportFingerprint(selected, BOB_ID, "remap")).not.toBe(remap);
  expect(
    workspaceArchiveFilename(selected.manifest.sourceWorkspaceId, selected.manifest.exportedAt),
  ).toBe(`lore-workspace-${selected.manifest.sourceWorkspaceId}-2026-08-09.json`);
});
