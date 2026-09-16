import type { DeploymentCapabilities, ReadinessReport } from "@corespeed/lore-sdk";
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
