import { afterEach, expect, test, vi } from "vitest";
import { listMemories, listWorkspaces } from "@/lib/lore-api";
import { clearRequestLog, getRequestLog } from "@/lib/request-log";
import type { Memory } from "@/lib/types";

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
