import { requestJson } from "@/shared/browser/http";
import type { DeploymentCapabilities, ReadinessReport } from "./service";

export function getDeploymentCapabilities(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<DeploymentCapabilities> {
  return requestJson("/api/v1/capabilities", {
    workspaceId,
    operation: "GET /api/v1/capabilities",
    signal,
  });
}

export function getReadiness(signal?: AbortSignal): Promise<ReadinessReport> {
  return requestJson("/readyz", {
    acceptedStatuses: [503],
    operation: "GET /readyz",
    signal,
  });
}
