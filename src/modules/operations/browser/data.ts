"use client";

import type { DeploymentCapabilities, ReadinessReport } from "@corespeed/lore-sdk";
import useSWR from "swr";
import { loreKeys } from "@/shared/browser/cache-keys";
import { getBrowserClient } from "@/shared/browser/sdk";

export function getDeploymentCapabilities(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<DeploymentCapabilities> {
  return getBrowserClient().workspace(workspaceId).capabilities(signal);
}

export function getReadiness(signal?: AbortSignal): Promise<ReadinessReport> {
  return getBrowserClient().readiness(signal);
}

export function useLoreDeploymentCapabilities(workspaceId: string) {
  return useSWR(
    workspaceId ? loreKeys.capabilities(workspaceId) : null,
    ([, , scopedWorkspaceId]) => getDeploymentCapabilities(scopedWorkspaceId),
  );
}

export function useLoreReadiness() {
  return useSWR(loreKeys.readiness, () => getReadiness(), {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
}
