# Generated from Lore's canonical OpenAPI document. Do not edit by hand.
from __future__ import annotations

from typing import Any, Final, Literal, NotRequired, TypeAlias, TypedDict, Union

LORE_API_VERSION: Final[str] = "v1"
LORE_ERROR_CODES: Final[frozenset[str]] = frozenset(["access_denied","authentication_required","idempotency_conflict","internal_error","invalid_archive","invalid_request","not_found","precondition_required","proposal_capacity_exceeded","proposal_review_conflict","version_conflict","workspace_export_limit_exceeded"])

class AgentCredential(TypedDict):
    id: str
    agentId: str
    prefix: str
    createdAt: str
    lastUsedAt: Union[str, None]
    revokedAt: Union[str, None]

class AgentWorkspaceGrant(TypedDict):
    workspaceId: str
    agentId: str
    permission: Literal["read", "write"]
    status: Literal["active", "revoked"]
    createdAt: str
    updatedAt: str

class Capabilities(TypedDict):
    apiVersion: Literal["v1"]
    schemaRevision: int
    deploymentId: str
    memoryChunking: dict[str, Any]
    features: dict[str, Any]
    limits: dict[str, Any]
    activeEmbeddingGeneration: Union[dict[str, Any], None]

class CiteMemoryCodeEvidenceInput(TypedDict):
    artifactId: str
    relationship: Literal["supports", "contradicts", "implements", "rationale"]

class CodeArtifact(TypedDict):
    id: str
    repositoryId: str
    revisionId: str
    generationId: str
    commitOid: str
    path: str
    language: str
    parser: Literal["tree_sitter", "text"]
    parseStatus: Literal["parsed", "recovered", "fallback"]
    kind: str
    symbol: Union[str, None]
    symbolKey: Union[str, None]
    declarationKey: Union[str, None]
    declarationChunkOrdinal: Union[int, None]
    symbols: list[CodeArtifactSymbol]
    ordinal: int
    startLine: int
    endLine: int
    content: str
    contentSha256: str
    matchedChannels: list[Literal["symbol", "literal", "lexical", "path"]]
    score: float

class CodeArtifactSymbol(TypedDict):
    symbol: str
    symbolKey: str
    declarationKey: str

CodeDependencyEdge = TypedDict(
    "CodeDependencyEdge",
  {
    "id": str,
    "kind": Literal["calls", "imports", "references"],
    "resolution": Literal["resolved", "ambiguous", "unresolved"],
    "targetText": str,
    "from": "CodeGraphLocator",
    "to": "CodeGraphLocator",
    "site": "CodeDependencySite",
  },
)

class CodeDependencyQueryAmbiguous(TypedDict):
    status: Literal["ambiguous"]
    repositoryKey: str
    commitOid: str
    direction: Literal["callers", "callees"]
    candidates: list[CodeGraphLocator]
    truncated: bool

class CodeDependencyQueryNotFound(TypedDict):
    status: Literal["not_found"]
    repositoryKey: str
    commitOid: str
    direction: Literal["callers", "callees"]
    candidates: list[CodeGraphLocator]

class CodeDependencyQueryOk(TypedDict):
    status: Literal["ok"]
    repositoryKey: str
    commitOid: str
    direction: Literal["callers", "callees"]
    subject: CodeGraphLocator
    edges: list[CodeDependencyEdge]
    truncated: bool

CodeDependencyQueryResult: TypeAlias = Union["CodeDependencyQueryOk", "CodeDependencyQueryAmbiguous", "CodeDependencyQueryNotFound"]

class CodeDependencySite(TypedDict):
    path: str
    startLine: int
    startColumn: int
    endLine: int
    endColumn: int

class CodeGraphLocator(TypedDict):
    artifactId: Union[str, None]
    path: Union[str, None]
    symbol: Union[str, None]
    symbolKey: Union[str, None]

class CodeIndexJob(TypedDict):
    id: str
    repositoryId: str
    repositoryKey: str
    commitOid: str
    sourceRef: Union[str, None]
    indexerRevision: str
    status: Literal["pending", "processing", "succeeded", "dead", "cancelled"]
    attemptCount: int
    maximumAttempts: int
    availableAt: str
    completedAt: Union[str, None]
    lastError: Union[str, None]
    createdAt: str
    updatedAt: str

class ContextRetrievalPlan(TypedDict):
    intent: Literal["blast-radius", "change", "current-code", "memory-recall", "rationale", "unknown"]
    route: Literal["abstain", "both", "code-only", "memory-only"]
    needsAnchorExpansion: bool
    needsContextualImpact: bool
    needsLocalAssessment: bool
    reasons: list[str]

class ContextRetrievalReceipt(TypedDict):
    memoryCandidates: int
    codeCandidates: int
    anchorCandidates: int
    requestedCommitOid: Union[str, None]
    memoryQuery: Union[str, None]
    codeQuery: Union[str, None]
    contextualImpact: Union[ContextualImpactAssessment, None]

class ContextualImpactAssessment(TypedDict):
    state: Literal["affected", "possibly_affected", "unaffected", "unknown"]
    changes: list[str]

class CreateEvaluationSuiteInput(TypedDict):
    name: str
    version: NotRequired[int]
    description: NotRequired[str]
    cases: list[EvaluationCaseInput]

class CreateMemoryInput(TypedDict):
    content: str
    scope: NotRequired[Literal["shared", "private"]]
    metadata: NotRequired[dict[str, Any]]

class CreateMemoryProposalCreateInput(TypedDict):
    kind: Literal["create"]
    content: str
    scope: NotRequired[Literal["shared", "private"]]
    metadata: NotRequired[dict[str, Any]]
    evidenceMemoryIds: NotRequired[list[str]]
    evidenceObservationIds: NotRequired[list[str]]
    codeEvidence: NotRequired[list[ProposeMemoryCodeEvidenceInput]]

CreateMemoryProposalInput: TypeAlias = Union["CreateMemoryProposalCreateInput", "CreateMemoryProposalUpdateInput"]

CreateMemoryProposalUpdateInput: TypeAlias = Union["MemoryProposalUpdateContentInput", "MemoryProposalUpdateScopeInput", "MemoryProposalUpdateMetadataInput"]

class EnqueueCodeIndexInput(TypedDict):
    repositoryKey: str
    commitOid: str
    sourceRef: NotRequired[str]

class Episode(TypedDict):
    id: str
    workspaceId: str
    ownerUserId: str
    recordedByActorKind: Literal["human", "agent"]
    recordedByAgentId: Union[str, None]
    kind: Literal["conversation", "workflow", "document", "event"]
    scope: Literal["shared", "private"]
    startedAt: str
    endedAt: str
    observationCount: int
    createdAt: str
    observations: list[Observation]

class EpisodeSummary(TypedDict):
    id: str
    workspaceId: str
    ownerUserId: str
    recordedByActorKind: Literal["human", "agent"]
    recordedByAgentId: Union[str, None]
    kind: Literal["conversation", "workflow", "document", "event"]
    scope: Literal["shared", "private"]
    startedAt: str
    endedAt: str
    observationCount: int
    createdAt: str

class Error(TypedDict):
    code: Literal["access_denied", "authentication_required", "idempotency_conflict", "internal_error", "invalid_archive", "invalid_request", "not_found", "precondition_required", "proposal_capacity_exceeded", "proposal_review_conflict", "version_conflict", "workspace_export_limit_exceeded"]
    error: str

class EvaluationCase(TypedDict):
    id: str
    ordinal: int
    query: str
    expectedMemoryIds: list[str]
    forbiddenMemoryIds: list[str]
    limit: int

class EvaluationCaseInput(TypedDict):
    query: str
    expectedMemoryIds: list[str]
    forbiddenMemoryIds: NotRequired[list[str]]
    limit: NotRequired[int]

class EvaluationResult(TypedDict):
    id: str
    caseId: str
    retrievedMemoryIds: list[str]
    metrics: RankingMetrics
    latencyMs: float
    estimatedCostUsd: float

class EvaluationRun(TypedDict):
    id: str
    suiteId: str
    workspaceId: str
    status: Literal["running", "completed", "failed"]
    metrics: EvaluationRunMetrics
    error: Union[str, None]
    results: list[EvaluationResult]
    startedAt: str
    completedAt: Union[str, None]

class EvaluationRunMetrics(TypedDict):
    recallAtK: float
    reciprocalRank: float
    ndcgAtK: float
    isolationPassed: bool
    hardFailureCount: int
    caseCount: int
    averageLatencyMs: float
    estimatedCostUsd: float

class EvaluationSuite(TypedDict):
    id: str
    workspaceId: str
    createdByUserId: str
    name: str
    version: int
    description: str
    cases: list[EvaluationCase]
    createdAt: str
    updatedAt: str

class HumanActor(TypedDict):
    kind: Literal["human"]
    userId: str

class ImportWorkspaceInput(TypedDict):
    archive: WorkspaceArchive
    ownerMap: dict[str, str]
    dryRun: NotRequired[bool]
    conflictPolicy: NotRequired[Literal["error", "remap", "skip"]]

class IssuedAgentCredential(TypedDict):
    id: str
    prefix: str
    token: str

class Memory(TypedDict):
    id: str
    workspaceId: str
    ownerUserId: str
    createdByAgentId: Union[str, None]
    scope: Literal["shared", "private"]
    content: str
    metadata: dict[str, Any]
    version: int
    createdAt: str
    updatedAt: str

class MemoryCodeEvidence(TypedDict):
    id: str
    memoryId: str
    repositoryId: str
    citedRevisionId: str
    citedGenerationId: str
    citedArtifactId: str
    citedCommitOid: str
    citedPath: str
    citedSymbolKey: Union[str, None]
    citedDeclarationKey: Union[str, None]
    citedDeclarationChunkOrdinal: Union[int, None]
    citedDeclarationContextSha256: Union[str, None]
    citedContentSha256: str
    relationship: Literal["supports", "contradicts", "implements", "rationale"]
    validationState: Literal["current", "moved", "changed", "deleted", "ambiguous", "unverifiable"]
    validatedRevisionId: Union[str, None]
    validatedGenerationId: Union[str, None]
    validatedArtifactId: Union[str, None]
    validatedCommitOid: Union[str, None]
    validatedPath: Union[str, None]
    createdByUserId: str
    createdByAgentId: Union[str, None]
    createdAt: str
    validatedAt: str

class MemoryGraph(TypedDict):
    nodes: list[MemoryGraphNode]
    links: list[MemoryGraphLink]

class MemoryGraphLink(TypedDict):
    source: str
    target: str
    kind: str
    weight: float

class MemoryGraphNode(TypedDict):
    id: str
    reference: str
    label: str
    preview: str
    scope: Literal["shared", "private"]
    type: str
    updatedAt: str

class MemoryProposal(TypedDict):
    id: str
    workspaceId: str
    ownerUserId: str
    proposedByActorKind: Literal["human", "agent"]
    proposedByAgentId: Union[str, None]
    kind: Literal["create", "update"]
    targetMemoryId: Union[str, None]
    baseMemoryVersion: Union[int, None]
    proposedContent: str
    proposedScope: Literal["shared", "private"]
    proposedMetadata: dict[str, Any]
    evidenceMemoryIds: list[str]
    evidenceObservationIds: list[str]
    codeEvidence: list[MemoryProposalCodeEvidence]
    status: Literal["pending", "accepted", "rejected"]
    reviewedByUserId: Union[str, None]
    acceptedMemoryId: Union[str, None]
    createdAt: str
    reviewedAt: Union[str, None]

class MemoryProposalCodeEvidence(TypedDict):
    ordinal: int
    repositoryId: str
    citedRevisionId: str
    citedGenerationId: str
    citedArtifactId: str
    citedCommitOid: str
    citedPath: str
    citedSymbolKey: Union[str, None]
    citedDeclarationKey: Union[str, None]
    citedDeclarationChunkOrdinal: Union[int, None]
    citedDeclarationContextSha256: Union[str, None]
    citedContentSha256: str
    relationship: Literal["supports", "contradicts", "implements", "rationale"]

class MemoryProposalReviewResult(TypedDict):
    proposal: MemoryProposal
    memory: Union[Memory, None]

class MemoryProposalUpdateContentInput(TypedDict):
    kind: Literal["update"]
    targetMemoryId: str
    expectedVersion: int
    content: str
    scope: NotRequired[Literal["shared", "private"]]
    metadata: NotRequired[dict[str, Any]]
    evidenceMemoryIds: NotRequired[list[str]]
    evidenceObservationIds: NotRequired[list[str]]
    codeEvidence: NotRequired[list[ProposeMemoryCodeEvidenceInput]]

class MemoryProposalUpdateMetadataInput(TypedDict):
    kind: Literal["update"]
    targetMemoryId: str
    expectedVersion: int
    content: NotRequired[str]
    scope: NotRequired[Literal["shared", "private"]]
    metadata: dict[str, Any]
    evidenceMemoryIds: NotRequired[list[str]]
    evidenceObservationIds: NotRequired[list[str]]
    codeEvidence: NotRequired[list[ProposeMemoryCodeEvidenceInput]]

class MemoryProposalUpdateScopeInput(TypedDict):
    kind: Literal["update"]
    targetMemoryId: str
    expectedVersion: int
    content: NotRequired[str]
    scope: Literal["shared", "private"]
    metadata: NotRequired[dict[str, Any]]
    evidenceMemoryIds: NotRequired[list[str]]
    evidenceObservationIds: NotRequired[list[str]]
    codeEvidence: NotRequired[list[ProposeMemoryCodeEvidenceInput]]

class MemorySearchResult(TypedDict):
    memory: Memory
    score: float
    rerankScore: NotRequired[float]
    evidence: str

class Observation(TypedDict):
    id: str
    workspaceId: str
    episodeId: str
    ordinal: int
    kind: Literal["message", "tool_call", "tool_result", "document_fragment", "event"]
    observedAt: str
    payloadSha256: str
    content: str
    metadata: dict[str, Any]
    createdAt: str

class ProposeMemoryCodeEvidenceInput(TypedDict):
    artifactId: str
    relationship: Literal["supports", "contradicts", "implements", "rationale"]

class RankingMetrics(TypedDict):
    recallAtK: float
    reciprocalRank: float
    ndcgAtK: float
    isolationPassed: bool
    forbiddenRetrievedIds: list[str]

class ReadinessReport(TypedDict):
    status: Literal["ready", "degraded", "unready"]
    components: dict[str, Any]

class RecordEpisodeInput(TypedDict):
    kind: Literal["conversation", "workflow", "document", "event"]
    scope: NotRequired[Literal["shared", "private"]]
    observations: list[RecordObservationInput]

class RecordObservationInput(TypedDict):
    kind: Literal["message", "tool_call", "tool_result", "document_fragment", "event"]
    content: str
    metadata: NotRequired[dict[str, Any]]
    observedAt: NotRequired[str]

class RetrieveContextInput(TypedDict):
    query: str
    memoryQuery: NotRequired[str]
    codeQuery: NotRequired[str]
    repositoryKey: NotRequired[str]
    commitOid: NotRequired[str]
    route: NotRequired[Literal["auto", "both", "code-only", "memory-only"]]
    memoryLimit: NotRequired[int]
    codeLimit: NotRequired[int]
    scope: NotRequired[Literal["shared", "private"]]
    metadata: NotRequired[dict[str, Any]]
    pathPrefix: NotRequired[str]

class RetrievedAnchorContext(TypedDict):
    id: str
    memoryId: str
    relationship: Literal["supports", "contradicts", "implements", "rationale"]
    localState: Literal["current", "moved", "changed", "deleted", "ambiguous", "unverifiable"]
    citedCommitOid: str
    citedPath: str
    validatedCommitOid: Union[str, None]
    validatedPath: Union[str, None]

class RetrievedCodeContext(TypedDict):
    artifactId: str
    commitOid: str
    path: str
    symbol: Union[str, None]
    startLine: int
    endLine: int
    score: float
    matchedChannels: list[Literal["symbol", "literal", "lexical", "path"]]
    content: str

class RetrievedContext(TypedDict):
    revision: Literal["joint-memory-code-v2"]
    query: str
    plan: ContextRetrievalPlan
    deliveredRoute: Literal["abstain", "both", "code-only", "memory-only"]
    memories: list[RetrievedMemoryContext]
    code: list[RetrievedCodeContext]
    anchors: list[RetrievedAnchorContext]
    conflicts: list[str]
    receipt: ContextRetrievalReceipt

class RetrievedMemoryContext(TypedDict):
    id: str
    scope: Literal["shared", "private"]
    updatedAt: str
    score: float
    rerankScore: NotRequired[float]
    evidence: str

class RevalidateMemoryCodeEvidenceInput(TypedDict):
    repositoryKey: str
    commitOid: str

class UpdateAgentInput(TypedDict):
    name: NotRequired[str]
    status: NotRequired[Literal["active", "disabled"]]

class UpdateMemoryInput(TypedDict):
    content: NotRequired[str]
    scope: NotRequired[Literal["shared", "private"]]
    metadata: NotRequired[dict[str, Any]]

class Workspace(TypedDict):
    id: str
    name: str
    createdAt: str
    updatedAt: str

class WorkspaceAgent(TypedDict):
    id: str
    ownerUserId: str
    name: str
    status: Literal["active", "disabled"]
    permission: Literal["read", "write"]
    grantStatus: Literal["active", "revoked"]
    createdAt: str
    updatedAt: str

class WorkspaceArchive(TypedDict):
    manifest: WorkspaceArchiveManifest
    memories: list[WorkspaceArchiveMemory]
    links: list[WorkspaceArchiveLink]

class WorkspaceArchiveLink(TypedDict):
    id: str
    sourceMemoryId: str
    targetMemoryId: str
    kind: str
    weight: float
    metadata: dict[str, Any]
    createdAt: str
    updatedAt: str

class WorkspaceArchiveManifest(TypedDict):
    checksum: str
    exportedAt: str
    format: Literal["lore-workspace-v1"]
    memoryCount: int
    linkCount: int
    sourceDeploymentId: str
    sourceWorkspaceId: str
    visibility: Literal["actor-visible"]

class WorkspaceArchiveMemory(TypedDict):
    id: str
    ownerUserId: str
    scope: Literal["shared", "private"]
    content: str
    metadata: dict[str, Any]
    version: int
    createdAt: str
    updatedAt: str

class WorkspaceImportResult(TypedDict):
    archiveChecksum: str
    dryRun: bool
    importedLinks: int
    importedMemories: int
    memoryIdMap: dict[str, str]
    replayed: bool
    skippedMemories: int

class WorkspaceSummary(TypedDict):
    id: str
    name: str
    role: Literal["owner", "admin", "member"]
    createdAt: str
    updatedAt: str
