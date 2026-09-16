import type { MemoryProposal as SdkMemoryProposal } from "@corespeed/lore-sdk";
import { getBrowserClient } from "@/shared/browser/sdk";
import type { MemoryProposal, MemoryProposalReviewResult, MemoryProposalStatus } from "./types";

function mutableProposal(proposal: SdkMemoryProposal): MemoryProposal {
  return {
    ...proposal,
    evidenceMemoryIds: [...proposal.evidenceMemoryIds],
    evidenceObservationIds: [...proposal.evidenceObservationIds],
    codeEvidence: [...proposal.codeEvidence],
  };
}

export async function listMemoryProposals(
  workspaceId: string,
  status: MemoryProposalStatus,
  signal?: AbortSignal,
): Promise<MemoryProposal[]> {
  const proposals = await getBrowserClient()
    .workspace(workspaceId)
    .listMemoryProposals({ status, limit: 100, signal });
  return proposals.map(mutableProposal);
}

export async function reviewMemoryProposal(
  workspaceId: string,
  proposalId: string,
  decision: "accept" | "reject",
): Promise<MemoryProposalReviewResult> {
  const result = await getBrowserClient()
    .workspace(workspaceId)
    .reviewMemoryProposal(proposalId, decision);
  return { ...result, proposal: mutableProposal(result.proposal) };
}
