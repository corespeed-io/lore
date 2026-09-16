"use client";

import useSWR from "swr";
import { loreKeys } from "@/shared/browser/cache-keys";
import { getDeploymentCapabilities, getReadiness } from "./client";

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
