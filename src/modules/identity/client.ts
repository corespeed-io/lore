import { getBrowserClient } from "@/shared/browser/sdk";
import type { HumanActorSummary } from "./types";

export function getCurrentHumanActor(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<HumanActorSummary> {
  return getBrowserClient().workspace(workspaceId).getCurrentHumanActor(signal);
}
