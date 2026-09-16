import { getBrowserClient } from "@/shared/browser/sdk";
import type { CodeIndexJob, MemoryCodeEvidence } from "./types";

// Code Evidence is read through the same Actor/RLS request context as the Memory
// itself, so a citation the Actor cannot see simply never reaches the browser.
export async function listMemoryCodeEvidence(
  workspaceId: string,
  memoryId: string,
  signal?: AbortSignal,
): Promise<MemoryCodeEvidence[]> {
  return [
    ...(await getBrowserClient().workspace(workspaceId).listMemoryCodeEvidence(memoryId, signal)),
  ];
}

export async function listCodeIndexJobs(
  workspaceId: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<CodeIndexJob[]> {
  return [
    ...(await getBrowserClient().workspace(workspaceId).listCodeIndexJobs({ limit, signal })),
  ];
}
