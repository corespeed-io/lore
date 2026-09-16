import { requestJson } from "@/shared/browser/http";
import type { HumanActorSummary } from "./types";

export function getCurrentHumanActor(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<HumanActorSummary> {
  return requestJson("/api/v1/actor", {
    workspaceId,
    operation: "GET /api/v1/actor",
    signal,
  });
}
