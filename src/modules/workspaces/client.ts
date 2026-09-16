import { getBrowserClient } from "@/shared/browser/sdk";
import type { WorkspaceSummary } from "./types";

export async function listWorkspaces(signal?: AbortSignal): Promise<WorkspaceSummary[]> {
  return [...(await getBrowserClient().listWorkspaces(signal))];
}

export async function createWorkspace(name: string): Promise<WorkspaceSummary> {
  const workspace = await getBrowserClient().createWorkspace(name);
  return { ...workspace, role: "owner" };
}
