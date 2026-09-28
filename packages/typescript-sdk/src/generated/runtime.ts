// Generated from Lore's canonical OpenAPI document. Do not edit by hand.
export const LORE_ERROR_CODES = [
  "access_denied",
  "agent_not_disabled",
  "authentication_required",
  "idempotency_conflict",
  "internal_error",
  "invalid_archive",
  "invalid_request",
  "memory_link_capacity_exceeded",
  "method_not_allowed",
  "not_found",
  "payload_too_large",
  "precondition_required",
  "proposal_capacity_exceeded",
  "proposal_review_conflict",
  "transaction_conflict",
  "version_conflict",
  "workspace_export_limit_exceeded"
] as const;

export const MEMORY_CONTENT_LIMITS = {
  "recommendedCharacters": 8000,
  "maximumCharacters": 32000
} as const;

/** Published vocabularies, bounds, defaults, and patterns; clients never restate them. */
export const LORE_CONTRACT = {
  "vocabularies": {
    "memoryScopes": [
      "shared",
      "private"
    ],
    "episodeKinds": [
      "conversation",
      "workflow",
      "document",
      "event"
    ],
    "observationKinds": [
      "message",
      "tool_call",
      "tool_result",
      "document_fragment",
      "event"
    ],
    "memoryProposalKinds": [
      "create",
      "update"
    ],
    "memoryProposalStatuses": [
      "pending",
      "accepted",
      "rejected"
    ],
    "codeEvidenceRelationships": [
      "supports",
      "contradicts",
      "implements",
      "rationale"
    ],
    "codeEvidenceValidationStates": [
      "current",
      "moved",
      "changed",
      "deleted",
      "ambiguous",
      "unverifiable"
    ],
    "codeIndexJobStatuses": [
      "pending",
      "processing",
      "succeeded",
      "dead",
      "cancelled"
    ],
    "codeDependencyKinds": [
      "calls",
      "imports",
      "references"
    ],
    "codeDependencyResolutions": [
      "resolved",
      "ambiguous",
      "unresolved"
    ],
    "codeDependencyDirections": [
      "callers",
      "callees"
    ],
    "codeSearchChannels": [
      "symbol",
      "literal",
      "lexical",
      "path"
    ],
    "memoryLinkDirections": [
      "outbound",
      "inbound"
    ],
    "contextRoutes": [
      "auto",
      "both",
      "code-only",
      "memory-only"
    ],
    "contextPlanRoutes": [
      "abstain",
      "both",
      "code-only",
      "memory-only"
    ],
    "contextIntents": [
      "blast-radius",
      "change",
      "current-code",
      "memory-recall",
      "rationale",
      "unknown"
    ],
    "contextImpactStates": [
      "affected",
      "possibly_affected",
      "unaffected",
      "unknown"
    ]
  },
  "limits": {
    "memoryMetadataSerializedLength": 100000,
    "memorySearchQueryLength": 10000,
    "memoryListLimit": 100,
    "memoryListLimitDefault": 50,
    "memorySearchLimitDefault": 10,
    "memoryMetadataFilterLength": 10000,
    "memoryListOffset": 1000000,
    "graphNodes": 5000,
    "memoryProposalEvidence": 50,
    "memoryProposalList": 100,
    "memoryProposalListDefault": 50,
    "episodeObservations": 100,
    "episodeContentCharacters": 1000000,
    "episodeMetadataCharacters": 1000000,
    "observationContentCharacters": 100000,
    "observationBatchRead": 50,
    "codeSearchResults": 100,
    "codeDependencyResults": 200,
    "codeQueryLength": 2000,
    "codeSymbolLength": 1600,
    "codeSourceRefLength": 512,
    "repositoryKeyLength": 512,
    "repositoryPathLength": 1024,
    "contextMemoryLimit": 10,
    "contextMemoryLimitDefault": 5,
    "contextCodeLimit": 20,
    "contextCodeLimitDefault": 10,
    "codeDependencyResultsDefault": 50,
    "codeIndexJobList": 100,
    "codeIndexJobListDefault": 20,
    "cursorLength": 512,
    "idempotencyKeyLength": 128,
    "memoryLinkKindLength": 64,
    "memoryLinkWeightMinimum": 0,
    "memoryLinkMetadataSerializedLength": 1000,
    "memoryLinkList": 100,
    "memoryLinkListDefault": 50,
    "memoryLinkWeightMaximum": 1,
    "workspaceNameLength": 120
  },
  "defaults": {
    "memoryLinkKind": "related",
    "memoryLinkWeight": 1
  },
  "patterns": {
    "commitOid": "^[0-9a-f]{40}([0-9a-f]{24})?$",
    "idempotencyKey": "^[\\x21-\\x7e]{1,128}$"
  }
} as const;
