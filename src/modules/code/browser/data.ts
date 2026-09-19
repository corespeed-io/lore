"use client";

import type { CodeIndexJob, MemoryCodeEvidence } from "@corespeed/lore-sdk";
import useSWR from "swr";
import { loreKeys } from "@/shared/browser/cache-keys";
import { getBrowserClient } from "@/shared/browser/sdk";

// Code Evidence is read through the same Actor/RLS request context as the Memory
// itself, so a citation the Actor cannot see simply never reaches the browser.
export function listMemoryCodeEvidence(
  workspaceId: string,
  memoryId: string,
  signal?: AbortSignal,
): Promise<readonly MemoryCodeEvidence[]> {
  return getBrowserClient().workspace(workspaceId).listMemoryCodeEvidence(memoryId, signal);
}

export function listCodeIndexJobs(
  workspaceId: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<readonly CodeIndexJob[]> {
  return getBrowserClient().workspace(workspaceId).listCodeIndexJobs({ limit, signal });
}

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
