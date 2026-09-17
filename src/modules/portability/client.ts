import type {
  ImportWorkspaceInput,
  WorkspaceArchive,
  WorkspaceImportResult,
} from "@corespeed/lore-sdk";
import { getBrowserClient } from "@/shared/browser/sdk";

export function exportWorkspaceArchive(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceArchive> {
  return getBrowserClient().workspace(workspaceId).exportWorkspace(signal);
}

export function importWorkspaceArchive(
  workspaceId: string,
  input: ImportWorkspaceInput,
): Promise<WorkspaceImportResult> {
  return getBrowserClient().workspace(workspaceId).importWorkspace(input);
}
