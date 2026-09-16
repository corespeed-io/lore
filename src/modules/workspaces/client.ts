import { requestJson } from "@/shared/browser/http";
import type { WorkspaceSummary } from "./types";

export function listWorkspaces(signal?: AbortSignal): Promise<WorkspaceSummary[]> {
  return requestJson("/api/workspaces", {
    operation: "GET /api/workspaces",
    signal,
  });
}

export async function createWorkspace(name: string): Promise<WorkspaceSummary> {
  const workspace = await requestJson<Omit<WorkspaceSummary, "role">>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
    operation: "POST /api/workspaces",
  });
  return { ...workspace, role: "owner" };
}
