"use client";

import useSWR from "swr";
import { loreKeys } from "@/shared/browser/cache-keys";
import { listCodeIndexJobs, listMemoryCodeEvidence } from "./client";

export function useLoreMemoryCodeEvidence(workspaceId: string, memoryId: string | null) {
  return useSWR(
    workspaceId && memoryId ? loreKeys.memoryCodeEvidence(workspaceId, memoryId) : null,
    ([, , scopedWorkspaceId, scopedMemoryId]) =>
      listMemoryCodeEvidence(scopedWorkspaceId, scopedMemoryId),
  );
}

export function useLoreCodeIndexJobs(workspaceId: string, limit = 20) {
  return useSWR(
    workspaceId ? loreKeys.codeIndexJobs(workspaceId, limit) : null,
    ([, , scopedWorkspaceId, scopedLimit]) => listCodeIndexJobs(scopedWorkspaceId, scopedLimit),
    { refreshInterval: 15_000, revalidateOnFocus: true },
  );
}
