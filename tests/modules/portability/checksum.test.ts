import { expect, test } from "vitest";
import { workspaceArchiveChecksum } from "@/modules/portability/checksum";

// A permanent format: every exported archive carries this checksum. If this value
// changes, archives already exported fail validation on import.
test("the archive checksum of a fixed payload never changes", async () => {
  const payload = {
    manifest: {
      format: "lore-workspace-v1",
      exportedAt: "2026-09-26T00:00:00.000Z",
      sourceWorkspaceId: "20000000-0000-4000-8000-000000000001",
      sourceDeploymentId: "30000000-0000-4000-8000-000000000001",
      memoryCount: 1,
      linkCount: 0,
    },
    memories: [
      {
        id: "40000000-0000-4000-8000-000000000001",
        ownerUserId: "10000000-0000-4000-8000-000000000001",
        scope: "shared",
        content: "Golden archive Memory.",
        metadata: { Zeta: 1, alpha: [true, null, "é"], Beta: { b: 2, a: 1 } },
        version: 1,
        createdAt: "2026-09-26T00:00:00.000Z",
        updatedAt: "2026-09-26T00:00:00.000Z",
      },
    ],
    links: [],
  };
  await expect(workspaceArchiveChecksum(payload)).resolves.toBe(
    "61050e6e9b44b9f9523a07cc29184af5d5edc96f00e84ed243a70c3dc555ed3d",
  );
  // Key order in the input does not matter; canonical order does.
  await expect(
    workspaceArchiveChecksum({ links: [], memories: payload.memories, manifest: payload.manifest }),
  ).resolves.toBe("61050e6e9b44b9f9523a07cc29184af5d5edc96f00e84ed243a70c3dc555ed3d");
});
