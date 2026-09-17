import type { Observation } from "@corespeed/lore-sdk";
import { getBrowserClient } from "@/shared/browser/sdk";

export function getObservations(
  workspaceId: string,
  observationIds: readonly string[],
  signal?: AbortSignal,
): Promise<readonly Observation[]> {
  return getBrowserClient().workspace(workspaceId).getObservations(observationIds, signal);
}
