import type { Memory, MemoryScope } from "@/modules/memories/types";

export type MemoryProposalStatus = "pending" | "accepted" | "rejected";

export interface MemoryProposalCodeEvidence {
  ordinal: number;
  repositoryId: string;
  citedRevisionId: string;
  citedGenerationId: string;
  citedArtifactId: string;
  citedCommitOid: string;
  citedPath: string;
  citedSymbolKey: string | null;
  citedDeclarationKey: string | null;
  citedDeclarationChunkOrdinal: number | null;
  citedDeclarationContextSha256: string | null;
  citedContentSha256: string;
  relationship: "contradicts" | "implements" | "rationale" | "supports";
}

export interface MemoryProposal {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  proposedByActorKind: "human" | "agent";
  proposedByAgentId: string | null;
  kind: "create" | "update";
  targetMemoryId: string | null;
  baseMemoryVersion: number | null;
  proposedContent: string;
  proposedScope: MemoryScope;
  proposedMetadata: Record<string, unknown>;
  evidenceMemoryIds: string[];
  evidenceObservationIds: string[];
  codeEvidence: MemoryProposalCodeEvidence[];
  status: MemoryProposalStatus;
  reviewedByUserId: string | null;
  acceptedMemoryId: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface MemoryProposalReviewResult {
  proposal: MemoryProposal;
  memory: Memory | null;
}
