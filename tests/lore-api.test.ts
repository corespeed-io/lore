import { afterEach, expect, test, vi } from "vitest";
import {
  deleteAgent,
  exportWorkspaceArchive,
  getCurrentHumanActor,
  getDeploymentCapabilities,
  getReadiness,
  importWorkspaceArchive,
  listAgentCredentials,
  listMemories,
  listMemoryProposals,
  listWorkspaces,
  reviewMemoryProposal,
  setAgentGrant,
  updateAgent,
} from "@/lib/lore-api";
import type { WorkspaceArchive } from "@/lib/portability";
import { clearRequestLog, getRequestLog } from "@/lib/request-log";
import type { Memory, MemoryProposal } from "@/lib/types";

function memory(index: number): Memory {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    workspaceId: "10000000-0000-4000-8000-000000000001",
    ownerUserId: "20000000-0000-4000-8000-000000000001",
    createdByAgentId: null,
    scope: "shared",
    content: `Memory ${index}`,
    metadata: {},
    version: 1,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
}

function proposal(): MemoryProposal {
  return {
    id: "50000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000001",
    ownerUserId: "20000000-0000-4000-8000-000000000001",
    proposedByActorKind: "agent",
    proposedByAgentId: "30000000-0000-4000-8000-000000000001",
    kind: "create",
    targetMemoryId: null,
    baseMemoryVersion: null,
    proposedContent: "Proposed fact",
    proposedScope: "private",
    proposedMetadata: {},
    evidenceMemoryIds: [],
    status: "pending",
    reviewedByUserId: null,
    acceptedMemoryId: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    reviewedAt: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearRequestLog();
});

test("native browser client reads a Memory page with Workspace context", async () => {
  const batch = Array.from({ length: 100 }, (_, index) => memory(index));
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(batch));
  vi.stubGlobal("fetch", fetchMock);

  const workspaceId = "10000000-0000-4000-8000-000000000001";
  const memories = await listMemories(workspaceId, { limit: 100, offset: 200 });

  expect(memories).toHaveLength(100);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0][0])).toContain("offset=200");
  const firstRequest = fetchMock.mock.calls[0][1];
  expect(firstRequest).toBeDefined();
  expect((firstRequest?.headers as Headers | undefined)?.get("x-lore-workspace-id")).toBe(
    workspaceId,
  );
  expect(getRequestLog().map((entry) => entry.operation)).toEqual(["GET /api/memories"]);
});

test("intentional request cancellation is not reported as an API failure", async () => {
  const aborted = new Error("request cancelled");
  aborted.name = "AbortError";
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(aborted));

  await expect(listWorkspaces()).rejects.toBe(aborted);
  expect(getRequestLog()).toEqual([]);
});

test("Agent browser client scopes credential reads and grant updates to one Workspace", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json({ status: "active", permission: "write" }));
  vi.stubGlobal("fetch", fetchMock);
  const workspaceId = "10000000-0000-4000-8000-000000000001";
  const agentId = "30000000-0000-4000-8000-000000000001";

  await listAgentCredentials(workspaceId, agentId);
  await setAgentGrant(workspaceId, agentId, "write");

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[0][0])).toContain(`/agents/${agentId}/credentials`);
  const credentialRequest = fetchMock.mock.calls[0][1];
  if (!credentialRequest) throw new Error("Expected credential request options");
  expect((credentialRequest.headers as Headers).get("x-lore-workspace-id")).toBe(workspaceId);
  expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PUT" });
  expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ permission: "write" }));
});

test("Agent browser client scopes global lifecycle mutations through the selected Workspace", async () => {
  const workspaceId = "10000000-0000-4000-8000-000000000001";
  const agentId = "30000000-0000-4000-8000-000000000001";
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        id: agentId,
        ownerUserId: "20000000-0000-4000-8000-000000000001",
        name: "Deployment assistant",
        status: "disabled",
        permission: "write",
        grantStatus: "active",
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:01:00.000Z",
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);

  await updateAgent(workspaceId, agentId, {
    name: "Deployment assistant",
    status: "disabled",
  });
  await deleteAgent(workspaceId, agentId);

  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const call of fetchMock.mock.calls) {
    const options = call[1];
    if (!options) throw new Error("Expected request options");
    expect((options.headers as Headers).get("x-lore-workspace-id")).toBe(workspaceId);
    expect(String(call[0])).toContain(`/api/v1/agents/${agentId}`);
  }
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    method: "PATCH",
    body: JSON.stringify({ name: "Deployment assistant", status: "disabled" }),
  });
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
});

test("Proposal browser client scopes review history and decisions to one Workspace", async () => {
  const pending = proposal();
  const reviewed = {
    proposal: {
      ...pending,
      status: "rejected" as const,
      reviewedByUserId: pending.ownerUserId,
      reviewedAt: "2026-08-10T00:05:00.000Z",
    },
    memory: null,
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json([pending]))
    .mockResolvedValueOnce(Response.json(reviewed));
  vi.stubGlobal("fetch", fetchMock);

  await expect(listMemoryProposals(pending.workspaceId, "pending")).resolves.toEqual([pending]);
  await expect(reviewMemoryProposal(pending.workspaceId, pending.id, "reject")).resolves.toEqual(
    reviewed,
  );

  expect(String(fetchMock.mock.calls[0]?.[0])).toContain("status=pending&limit=100");
  expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`/${pending.id}/review`);
  for (const call of fetchMock.mock.calls) {
    expect(new Headers(call[1]?.headers).get("x-lore-workspace-id")).toBe(pending.workspaceId);
  }
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({ decision: "reject" }),
  });
});

test("Operations browser client treats bounded 503 readiness as a typed unready report", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json(
        {
          status: "unready",
          components: {
            database: "unavailable",
            embedding: "unknown",
            rlsRole: "unavailable",
            schema: "unavailable",
            vector: "unavailable",
          },
        },
        { status: 503 },
      ),
    ),
  );

  await expect(getReadiness()).resolves.toMatchObject({ status: "unready" });
  expect(getRequestLog()).toMatchObject([{ operation: "GET /readyz", ok: true }]);
});

test("Operations browser client scopes Actor, capabilities, export, and dry-run import to one Workspace", async () => {
  const workspaceId = "10000000-0000-4000-8000-000000000001";
  const archive: WorkspaceArchive = {
    manifest: {
      checksum: "a".repeat(64),
      exportedAt: "2026-08-09T00:00:00.000Z",
      format: "lore-workspace-v1",
      memoryCount: 0,
      linkCount: 0,
      sourceDeploymentId: "20000000-0000-4000-8000-000000000001",
      sourceWorkspaceId: workspaceId,
      visibility: "actor-visible",
    },
    memories: [],
    links: [],
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ kind: "human", userId: "30000000-0000-4000-8000-000000000001" }),
    )
    .mockResolvedValueOnce(
      Response.json({
        apiVersion: "v1",
        schemaRevision: 8,
        deploymentId: "20000000-0000-4000-8000-000000000001",
        features: {},
        limits: {
          workspaceArchiveMemories: 10_000,
          workspaceArchiveLinks: 50_000,
          memoryProposalEvidence: 50,
          memoryProposalList: 100,
        },
        activeEmbeddingGeneration: null,
      }),
    )
    .mockResolvedValueOnce(Response.json(archive))
    .mockResolvedValueOnce(
      Response.json({
        archiveChecksum: archive.manifest.checksum,
        dryRun: true,
        importedLinks: 0,
        importedMemories: 0,
        memoryIdMap: {},
        replayed: false,
        skippedMemories: 0,
      }),
    );
  vi.stubGlobal("fetch", fetchMock);

  await expect(getCurrentHumanActor(workspaceId)).resolves.toMatchObject({ kind: "human" });
  await getDeploymentCapabilities(workspaceId);
  await expect(exportWorkspaceArchive(workspaceId)).resolves.toEqual(archive);
  await importWorkspaceArchive(workspaceId, { archive, ownerMap: {}, dryRun: true });

  for (const call of fetchMock.mock.calls) {
    const options = call[1];
    if (!options) throw new Error("Expected request options");
    expect((options.headers as Headers).get("x-lore-workspace-id")).toBe(workspaceId);
  }
  expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: "POST" });
  expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({
    archive,
    ownerMap: {},
    dryRun: true,
  });
});
