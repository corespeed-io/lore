"use client";

import type { HumanActor, WorkspaceSummary } from "@corespeed/lore-sdk";
import useSWR from "swr";
import { loreKeys } from "@/shared/browser/cache-keys";
import { getBrowserClient } from "@/shared/browser/sdk";

export function listWorkspaces(signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> {
  return getBrowserClient().listWorkspaces(signal);
}

export async function createWorkspace(name: string): Promise<WorkspaceSummary> {
  const workspace = await getBrowserClient().createWorkspace(name);
  return { ...workspace, role: "owner" };
}

export function useLoreWorkspaces() {
  return useSWR(loreKeys.workspaces, () => listWorkspaces());
}

export function getCurrentHumanActor(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<HumanActor> {
  return getBrowserClient().workspace(workspaceId).getCurrentHumanActor(signal);
}

export function useLoreCurrentHumanActor(workspaceId: string) {
  return useSWR(
    workspaceId ? loreKeys.currentActor(workspaceId) : null,
    ([, , scopedWorkspaceId]) => getCurrentHumanActor(scopedWorkspaceId),
  );
}
