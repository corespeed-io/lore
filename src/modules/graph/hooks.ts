"use client";

import useSWR from "swr";
import { loreKeys } from "@/shared/browser/cache-keys";
import { readGraph } from "./client";

export function useLoreGraph(workspaceId: string) {
  return useSWR(workspaceId ? loreKeys.graph(workspaceId) : null, ([, , scopedWorkspaceId]) =>
    readGraph(scopedWorkspaceId),
  );
}
