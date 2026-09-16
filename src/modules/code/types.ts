export type CodeEvidenceRelationship = "contradicts" | "implements" | "rationale" | "supports";

export type CodeEvidenceValidationState =
  | "ambiguous"
  | "changed"
  | "current"
  | "deleted"
  | "moved"
  | "unverifiable";

// The browser mirror of the server `MemoryCodeEvidence` contract. Repository
// identity stays a Workspace-scoped UUID plus the cited commit OID; an
// operator-only `repositoryPath` is never part of the public surface.
export interface MemoryCodeEvidence {
  id: string;
  memoryId: string;
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
  relationship: CodeEvidenceRelationship;
  validationState: CodeEvidenceValidationState;
  validatedRevisionId: string | null;
  validatedGenerationId: string | null;
  validatedArtifactId: string | null;
  validatedCommitOid: string | null;
  validatedPath: string | null;
  createdByUserId: string;
  createdByAgentId: string | null;
  createdAt: string;
  validatedAt: string;
}

export type CodeIndexJobStatus = "cancelled" | "dead" | "pending" | "processing" | "succeeded";

export interface CodeIndexJob {
  id: string;
  repositoryId: string;
  repositoryKey: string;
  commitOid: string;
  sourceRef: string | null;
  indexerRevision: string;
  status: CodeIndexJobStatus;
  attemptCount: number;
  maximumAttempts: number;
  availableAt: string;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
