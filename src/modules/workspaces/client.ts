import type { WorkspaceSummary } from "@corespeed/lore-sdk";
import { getBrowserClient } from "@/shared/browser/sdk";

export function listWorkspaces(signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> {
  return getBrowserClient().listWorkspaces(signal);
}

export async function createWorkspace(name: string): Promise<WorkspaceSummary> {
  const workspace = await getBrowserClient().createWorkspace(name);
  return { ...workspace, role: "owner" };
}
