"use client";

import type { Observation } from "@corespeed/lore-sdk";
import { useMemo } from "react";
import useSWR from "swr";
import { loreKeys } from "@/shared/browser/cache-keys";
import { getBrowserClient } from "@/shared/browser/sdk";

export function getObservations(
  workspaceId: string,
  observationIds: readonly string[],
  signal?: AbortSignal,
): Promise<readonly Observation[]> {
  return getBrowserClient().workspace(workspaceId).getObservations(observationIds, signal);
}

export function useLoreObservations(workspaceId: string, observationIds: readonly string[]) {
  const ids = useMemo(() => [...new Set(observationIds)], [observationIds]);
  return useSWR(workspaceId && ids.length ? loreKeys.observations(workspaceId, ids) : null, () =>
    getObservations(workspaceId, ids),
  );
}
