# Generated from Lore's canonical OpenAPI document. Do not edit by hand.
from __future__ import annotations

from typing import Any, Final, Literal, NotRequired, TypeAlias, TypedDict, Union

LORE_API_VERSION: Final[str] = "v1"
LORE_ERROR_CODES: Final[frozenset[str]] = frozenset(["access_denied","authentication_required","idempotency_conflict","internal_error","invalid_archive","invalid_request","not_found","precondition_required","version_conflict","workspace_export_limit_exceeded"])

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
    features: dict[str, Any]
    limits: dict[str, Any]
    activeEmbeddingGeneration: Union[dict[str, Any], None]

class CreateEvaluationSuiteInput(TypedDict):
    name: str
    version: NotRequired[int]
    description: NotRequired[str]
    cases: list[EvaluationCaseInput]

class CreateMemoryInput(TypedDict):
    content: str
    scope: NotRequired[Literal["shared", "private"]]
    metadata: NotRequired[dict[str, Any]]

class Error(TypedDict):
    code: Literal["access_denied", "authentication_required", "idempotency_conflict", "internal_error", "invalid_archive", "invalid_request", "not_found", "precondition_required", "version_conflict", "workspace_export_limit_exceeded"]
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

class MemorySearchResult(TypedDict):
    memory: Memory
    score: float
    rerankScore: NotRequired[float]
    evidence: str

class RankingMetrics(TypedDict):
    recallAtK: float
    reciprocalRank: float
    ndcgAtK: float
    isolationPassed: bool
    forbiddenRetrievedIds: list[str]

class ReadinessReport(TypedDict):
    status: Literal["ready", "degraded", "unready"]
    components: dict[str, Any]

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
