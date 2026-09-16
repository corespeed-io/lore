import { requestJson } from "@/shared/browser/http";
import type { ImportWorkspaceArchive, WorkspaceArchive, WorkspaceImportResult } from "./service";

export function exportWorkspaceArchive(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceArchive> {
  return requestJson("/api/v1/workspaces/export", {
    workspaceId,
    operation: "GET /api/v1/workspaces/export",
    signal,
  });
}

export function importWorkspaceArchive(
  workspaceId: string,
  input: ImportWorkspaceArchive,
): Promise<WorkspaceImportResult> {
  return requestJson("/api/v1/workspaces/import", {
    method: "POST",
    body: JSON.stringify(input),
    workspaceId,
    operation: "POST /api/v1/workspaces/import",
  });
}
