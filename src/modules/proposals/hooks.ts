"use client";

import type { MemoryProposalStatus } from "@corespeed/lore-sdk";
import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";
import { loreKeys } from "@/shared/browser/cache-keys";
import { listMemoryProposals, reviewMemoryProposal } from "./client";

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
