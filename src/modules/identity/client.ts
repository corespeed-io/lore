import type { HumanActor } from "@corespeed/lore-sdk";
import { getBrowserClient } from "@/shared/browser/sdk";

export function getCurrentHumanActor(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<HumanActor> {
  return getBrowserClient().workspace(workspaceId).getCurrentHumanActor(signal);
}
