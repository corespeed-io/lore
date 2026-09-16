import { requestJson } from "@/shared/browser/http";
import type { CodeIndexJob, MemoryCodeEvidence } from "./types";

// Code Evidence is read through the same Actor/RLS request context as the Memory
// itself, so a citation the Actor cannot see simply never reaches the browser.
export function listMemoryCodeEvidence(
  workspaceId: string,
  memoryId: string,
  signal?: AbortSignal,
): Promise<MemoryCodeEvidence[]> {
  return requestJson(`/api/v1/memories/${encodeURIComponent(memoryId)}/code-evidence`, {
    workspaceId,
    operation: "GET /api/v1/memories/:id/code-evidence",
    signal,
  });
}

export function listCodeIndexJobs(
  workspaceId: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<CodeIndexJob[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  return requestJson(`/api/v1/code/index-jobs?${params}`, {
    workspaceId,
    operation: "GET /api/v1/code/index-jobs",
    signal,
  });
}
