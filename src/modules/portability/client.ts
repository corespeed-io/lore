import type {
  ImportWorkspaceInput,
  WorkspaceArchive,
  WorkspaceImportResult,
} from "@corespeed/lore-sdk";
import { getBrowserClient } from "@/shared/browser/sdk";

export async function exportWorkspaceArchive(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceArchive> {
  const archive = await getBrowserClient().workspace(workspaceId).exportWorkspace(signal);
  return { ...archive, memories: [...archive.memories], links: [...archive.links] };
}

export function importWorkspaceArchive(
  workspaceId: string,
  input: ImportWorkspaceInput,
): Promise<WorkspaceImportResult> {
  return getBrowserClient().workspace(workspaceId).importWorkspace(input);
}
