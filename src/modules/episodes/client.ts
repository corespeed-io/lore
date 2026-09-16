import { requestJson } from "@/shared/browser/http";
import type { Observation } from "./types";

export function getObservations(
  workspaceId: string,
  observationIds: readonly string[],
  signal?: AbortSignal,
): Promise<Observation[]> {
  const params = new URLSearchParams();
  for (const id of observationIds) params.append("id", id);
  return requestJson(`/api/v1/observations?${params}`, {
    workspaceId,
    operation: "GET /api/v1/observations",
    signal,
  });
}
