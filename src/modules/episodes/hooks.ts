"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { loreKeys } from "@/shared/browser/cache-keys";
import { getObservations } from "./client";

export function useLoreObservations(workspaceId: string, observationIds: readonly string[]) {
  const ids = useMemo(() => [...new Set(observationIds)], [observationIds]);
  return useSWR(workspaceId && ids.length ? loreKeys.observations(workspaceId, ids) : null, () =>
    getObservations(workspaceId, ids),
  );
}
