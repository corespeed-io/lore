import { getBrowserClient } from "@/shared/browser/sdk";
import type { ImportWorkspaceArchive, WorkspaceArchive, WorkspaceImportResult } from "./service";

export async function exportWorkspaceArchive(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceArchive> {
  const archive = await getBrowserClient().workspace(workspaceId).exportWorkspace(signal);
  return { ...archive, memories: [...archive.memories], links: [...archive.links] };
}

export function importWorkspaceArchive(
  workspaceId: string,
  input: ImportWorkspaceArchive,
): Promise<WorkspaceImportResult> {
  return getBrowserClient().workspace(workspaceId).importWorkspace(input);
}
