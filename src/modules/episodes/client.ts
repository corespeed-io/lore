import { getBrowserClient } from "@/shared/browser/sdk";
import type { Observation } from "./types";

export async function getObservations(
  workspaceId: string,
  observationIds: readonly string[],
  signal?: AbortSignal,
): Promise<Observation[]> {
  return [
    ...(await getBrowserClient().workspace(workspaceId).getObservations(observationIds, signal)),
  ];
}
