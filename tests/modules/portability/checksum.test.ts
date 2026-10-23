import { expect, test } from "vitest";
import { workspaceArchiveChecksum } from "@/modules/portability/checksum";
import {
  WORKSPACE_ARCHIVE_FORMAT,
  type WorkspaceArchiveFormat,
} from "@/modules/portability/limits";

// Keys whose default-locale order (alpha, Beta, Zeta) differs from their UTF-16
// order (Beta, Zeta, alpha), so the two formats must produce different checksums.
function payload(format: WorkspaceArchiveFormat) {
  return {
    manifest: {
      format,
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
        // v3 and v4 carry each Memory's title and gloss, and v4 its occurredAt;
        // earlier formats cannot.
        ...(format === "lore-workspace-v3" || format === "lore-workspace-v4"
          ? { title: "Golden archive títle", gloss: "Golden archive gloss" }
          : {}),
        ...(format === "lore-workspace-v4" ? { occurredAt: "2026-09-25T08:30:00.000Z" } : {}),
        content: "Golden archive Memory.",
        metadata: { Zeta: 1, alpha: [true, null, "é"], Beta: { b: 2, a: 1 } },
        version: 1,
        createdAt: "2026-09-26T00:00:00.000Z",
        updatedAt: "2026-09-26T00:00:00.000Z",
      },
    ],
    links: [],
  };
}

// Permanent formats: every exported archive carries its checksum. If one of these
// values changes, archives already exported in that format fail import.
test.each([
  ["lore-workspace-v1", "61050e6e9b44b9f9523a07cc29184af5d5edc96f00e84ed243a70c3dc555ed3d"],
  ["lore-workspace-v2", "c99028f88147ceba6d6a6a616cbe9793a3471528b0a7b3dd2b7b5246b0930658"],
  ["lore-workspace-v3", "4b29887124e7622ce603b77189cacd4d1f14a59f6c94f219246b8a8430814512"],
  ["lore-workspace-v4", "111b7b0e9c0f78bdd378330d8ccb58ec17b1467c7908f6f10c4ac2896178a69e"],
] as const)("the %s checksum of a fixed payload never changes", async (format, checksum) => {
  const archive = payload(format);
  await expect(workspaceArchiveChecksum(archive, format)).resolves.toBe(checksum);
  // Key order in the input does not matter; canonical order does.
  await expect(
    workspaceArchiveChecksum(
      { links: archive.links, memories: archive.memories, manifest: archive.manifest },
      format,
    ),
  ).resolves.toBe(checksum);
});

test("v2 orders keys outside the BMP by UTF-16 code unit, not code point", async () => {
  // A surrogate pair (U+1F600 is D83D DE00) sorts before U+FF61 by code unit, but
  // after it by code point, so this pins the comparator exactly.
  const canonical = '{"z":4,"é":3,"\u{1F600}":2,"｡":1}';
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const expected = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await expect(
    workspaceArchiveChecksum({ "｡": 1, "\u{1F600}": 2, é: 3, z: 4 }, "lore-workspace-v2"),
  ).resolves.toBe(expected);
});

test("v2 orders keys by UTF-16 code unit, so it disagrees with v1 on mixed-case keys", async () => {
  const archive = payload("lore-workspace-v2");
  await expect(workspaceArchiveChecksum(archive, "lore-workspace-v2")).resolves.not.toBe(
    await workspaceArchiveChecksum(archive, "lore-workspace-v1"),
  );
});

test("v3 serializes as v2 does; only its payload adds titles", async () => {
  const archive = payload("lore-workspace-v3");
  await expect(workspaceArchiveChecksum(archive, "lore-workspace-v3")).resolves.toBe(
    await workspaceArchiveChecksum(archive, "lore-workspace-v2"),
  );
});

test("v4 serializes as v3 does; only its payload adds occurredAt", async () => {
  const archive = payload("lore-workspace-v4");
  await expect(workspaceArchiveChecksum(archive, "lore-workspace-v4")).resolves.toBe(
    await workspaceArchiveChecksum(archive, "lore-workspace-v3"),
  );
  expect(WORKSPACE_ARCHIVE_FORMAT).toBe("lore-workspace-v4");
});
