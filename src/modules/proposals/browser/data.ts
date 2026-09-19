"use client";

import type {
  MemoryProposal,
  MemoryProposalReviewResult,
  MemoryProposalStatus,
} from "@corespeed/lore-sdk";
import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";
import { loreKeys } from "@/shared/browser/cache-keys";
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

export function useLoreMemoryProposals(workspaceId: string, status: MemoryProposalStatus) {
  return useSWR(
    workspaceId ? loreKeys.memoryProposals(workspaceId, status) : null,
    ([, , scopedWorkspaceId, scopedStatus]) => listMemoryProposals(scopedWorkspaceId, scopedStatus),
  );
}

export function useLoreMemoryProposalMutations(workspaceId: string) {
  const { mutate: mutateCache } = useSWRConfig();
  const reviewProposalMutation = useSWRMutation(
    workspaceId ? loreKeys.reviewMemoryProposal(workspaceId) : null,
    (
      _key,
      {
        arg,
      }: {
        arg: { decision: "accept" | "reject"; proposalId: string };
      },
    ) => reviewMemoryProposal(workspaceId, arg.proposalId, arg.decision),
  );

  return {
    mutateCache,
    reviewProposal: reviewProposalMutation,
    isMutating: reviewProposalMutation.isMutating,
  };
}
