import type {
  MemoryProposal,
  MemoryProposalReviewResult,
  MemoryProposalStatus,
} from "@corespeed/lore-sdk";
import { getBrowserClient } from "@/shared/browser/sdk";

export function listMemoryProposals(
  workspaceId: string,
  status: MemoryProposalStatus,
  signal?: AbortSignal,
): Promise<readonly MemoryProposal[]> {
  return getBrowserClient()
    .workspace(workspaceId)
    .listMemoryProposals({ status, limit: 100, signal });
}

export function reviewMemoryProposal(
  workspaceId: string,
  proposalId: string,
  decision: "accept" | "reject",
): Promise<MemoryProposalReviewResult> {
  return getBrowserClient().workspace(workspaceId).reviewMemoryProposal(proposalId, decision);
}
