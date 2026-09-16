"use client";

import useSWR from "swr";
import { loreKeys } from "@/shared/browser/cache-keys";
import { getCurrentHumanActor } from "./client";

export function useLoreCurrentHumanActor(workspaceId: string) {
  return useSWR(
    workspaceId ? loreKeys.currentActor(workspaceId) : null,
    ([, , scopedWorkspaceId]) => getCurrentHumanActor(scopedWorkspaceId),
  );
}
