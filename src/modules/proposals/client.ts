import { requestJson } from "@/shared/browser/http";
import type { MemoryProposal, MemoryProposalReviewResult, MemoryProposalStatus } from "./types";

export function listMemoryProposals(
  workspaceId: string,
  status: MemoryProposalStatus,
  signal?: AbortSignal,
): Promise<MemoryProposal[]> {
  const params = new URLSearchParams({ status, limit: "100" });
  return requestJson(`/api/v1/memory-proposals?${params}`, {
    workspaceId,
    operation: "GET /api/v1/memory-proposals",
    signal,
  });
}

export function reviewMemoryProposal(
  workspaceId: string,
  proposalId: string,
  decision: "accept" | "reject",
): Promise<MemoryProposalReviewResult> {
  return requestJson(`/api/v1/memory-proposals/${encodeURIComponent(proposalId)}/review`, {
    method: "POST",
    body: JSON.stringify({ decision }),
    workspaceId,
    operation: "POST /api/v1/memory-proposals/:id/review",
  });
}
