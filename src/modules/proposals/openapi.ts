import { MEMORY_CONTENT_LIMITS } from "@corespeed/lore-core";
import {
  codeEvidenceRelationshipSchema,
  commitOidSchema,
  repositoryPathSchema,
} from "@/modules/code/openapi";
import {
  humanSecurity,
  idempotencyHeader,
  jsonResponse,
  memoryScopeSchema,
  metadataSchema,
  requestBody,
  workspaceHeader,
} from "@/server/openapi/shared";
import {
  DEFAULT_MEMORY_PROPOSAL_LIST,
  MAXIMUM_MEMORY_PROPOSAL_EVIDENCE,
  MAXIMUM_MEMORY_PROPOSAL_LIST,
  MEMORY_PROPOSAL_KINDS,
  MEMORY_PROPOSAL_STATUSES,
} from "./limits";

const evidenceLimitDescription = `Memory, Observation, and Code evidence have a combined limit of ${MAXIMUM_MEMORY_PROPOSAL_EVIDENCE}.`;

const proposalCodeEvidenceProperty = {
  type: "array",
  maxItems: MAXIMUM_MEMORY_PROPOSAL_EVIDENCE,
  description: evidenceLimitDescription,
  items: { $ref: "#/components/schemas/ProposeMemoryCodeEvidenceInput" },
} as const;

const memoryProposalUpdateProperties = {
  kind: { const: "update" },
  targetMemoryId: { type: "string", format: "uuid" },
  expectedVersion: { type: "integer", minimum: 1 },
  content: {
    type: "string",
    minLength: 1,
    maxLength: MEMORY_CONTENT_LIMITS.maximumCharacters,
  },
  scope: memoryScopeSchema,
  metadata: metadataSchema,
  evidenceMemoryIds: {
    type: "array",
    maxItems: MAXIMUM_MEMORY_PROPOSAL_EVIDENCE,
    description: evidenceLimitDescription,
    items: { type: "string", format: "uuid" },
  },
  evidenceObservationIds: {
    type: "array",
    maxItems: MAXIMUM_MEMORY_PROPOSAL_EVIDENCE,
    description: evidenceLimitDescription,
    items: { type: "string", format: "uuid" },
  },
  codeEvidence: proposalCodeEvidenceProperty,
} as const;

function memoryProposalUpdateVariant(change: "content" | "metadata" | "scope") {
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind", "targetMemoryId", "expectedVersion", change],
    properties: memoryProposalUpdateProperties,
  } as const;
}

export const proposalsPaths = {
  "/api/v1/memory-proposals": {
    get: {
      operationId: "listMemoryProposals",
      security: humanSecurity,
      parameters: [
        workspaceHeader,
        {
          name: "status",
          in: "query",
          schema: { type: "string", enum: [...MEMORY_PROPOSAL_STATUSES] },
        },
        {
          name: "limit",
          in: "query",
          schema: {
            type: "integer",
            minimum: 1,
            maximum: MAXIMUM_MEMORY_PROPOSAL_LIST,
            default: DEFAULT_MEMORY_PROPOSAL_LIST,
          },
        },
      ],
      responses: {
        "200": jsonResponse("Owner-private Memory Proposals", {
          type: "array",
          items: { $ref: "#/components/schemas/MemoryProposal" },
        }),
        "403": { $ref: "#/components/responses/Error" },
      },
    },
    post: {
      operationId: "createMemoryProposal",
      parameters: [workspaceHeader, idempotencyHeader],
      requestBody: requestBody({ $ref: "#/components/schemas/CreateMemoryProposalInput" }),
      responses: {
        "201": jsonResponse("Submitted owner-private Memory Proposal", {
          $ref: "#/components/schemas/MemoryProposal",
        }),
        "403": { $ref: "#/components/responses/Error" },
        "409": { $ref: "#/components/responses/Error" },
        "412": { $ref: "#/components/responses/Error" },
      },
    },
  },
  "/api/v1/memory-proposals/{proposalId}/review": {
    post: {
      operationId: "reviewMemoryProposal",
      security: humanSecurity,
      parameters: [
        workspaceHeader,
        {
          name: "proposalId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: requestBody({
        type: "object",
        additionalProperties: false,
        required: ["decision"],
        properties: { decision: { type: "string", enum: ["accept", "reject"] } },
      }),
      responses: {
        "200": jsonResponse(
          "Reviewed Memory Proposal",
          { $ref: "#/components/schemas/MemoryProposalReviewResult" },
          { ETag: { schema: { type: "string" } } },
        ),
        "403": { $ref: "#/components/responses/Error" },
        "404": { $ref: "#/components/responses/Error" },
        "409": { $ref: "#/components/responses/Error" },
        "412": { $ref: "#/components/responses/Error" },
      },
    },
  },
};

export const proposalsSchemas = {
  CreateMemoryProposalInput: {
    oneOf: [
      { $ref: "#/components/schemas/CreateMemoryProposalCreateInput" },
      { $ref: "#/components/schemas/CreateMemoryProposalUpdateInput" },
    ],
  },
  CreateMemoryProposalCreateInput: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "content"],
    properties: {
      kind: { const: "create" },
      content: {
        type: "string",
        minLength: 1,
        maxLength: MEMORY_CONTENT_LIMITS.maximumCharacters,
      },
      scope: { ...memoryScopeSchema, default: "shared" },
      metadata: metadataSchema,
      evidenceMemoryIds: {
        type: "array",
        maxItems: MAXIMUM_MEMORY_PROPOSAL_EVIDENCE,
        description: evidenceLimitDescription,
        items: { type: "string", format: "uuid" },
      },
      evidenceObservationIds: {
        type: "array",
        maxItems: MAXIMUM_MEMORY_PROPOSAL_EVIDENCE,
        description: evidenceLimitDescription,
        items: { type: "string", format: "uuid" },
      },
      codeEvidence: proposalCodeEvidenceProperty,
    },
  },
  CreateMemoryProposalUpdateInput: {
    anyOf: [
      { $ref: "#/components/schemas/MemoryProposalUpdateContentInput" },
      { $ref: "#/components/schemas/MemoryProposalUpdateScopeInput" },
      { $ref: "#/components/schemas/MemoryProposalUpdateMetadataInput" },
    ],
  },
  MemoryProposalUpdateContentInput: memoryProposalUpdateVariant("content"),
  MemoryProposalUpdateScopeInput: memoryProposalUpdateVariant("scope"),
  MemoryProposalUpdateMetadataInput: memoryProposalUpdateVariant("metadata"),
  ProposeMemoryCodeEvidenceInput: {
    type: "object",
    additionalProperties: false,
    required: ["artifactId", "relationship"],
    properties: {
      artifactId: { type: "string", format: "uuid" },
      relationship: codeEvidenceRelationshipSchema,
    },
  },
  MemoryProposalCodeEvidence: {
    type: "object",
    additionalProperties: false,
    required: [
      "ordinal",
      "repositoryId",
      "citedRevisionId",
      "citedGenerationId",
      "citedArtifactId",
      "citedCommitOid",
      "citedPath",
      "citedSymbolKey",
      "citedDeclarationKey",
      "citedDeclarationChunkOrdinal",
      "citedDeclarationContextSha256",
      "citedContentSha256",
      "relationship",
    ],
    properties: {
      ordinal: { type: "integer", minimum: 0, maximum: MAXIMUM_MEMORY_PROPOSAL_EVIDENCE - 1 },
      repositoryId: { type: "string", format: "uuid" },
      citedRevisionId: { type: "string", format: "uuid" },
      citedGenerationId: { type: "string", format: "uuid" },
      citedArtifactId: { type: "string", format: "uuid" },
      citedCommitOid: commitOidSchema,
      citedPath: repositoryPathSchema,
      citedSymbolKey: { oneOf: [{ type: "string" }, { type: "null" }] },
      citedDeclarationKey: { oneOf: [{ type: "string" }, { type: "null" }] },
      citedDeclarationChunkOrdinal: {
        oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
      },
      citedDeclarationContextSha256: {
        oneOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }],
      },
      citedContentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      relationship: codeEvidenceRelationshipSchema,
    },
  },
  MemoryProposal: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "workspaceId",
      "ownerUserId",
      "proposedByActorKind",
      "proposedByAgentId",
      "kind",
      "targetMemoryId",
      "baseMemoryVersion",
      "proposedContent",
      "proposedScope",
      "proposedMetadata",
      "evidenceMemoryIds",
      "evidenceObservationIds",
      "codeEvidence",
      "status",
      "reviewedByUserId",
      "acceptedMemoryId",
      "createdAt",
      "reviewedAt",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      workspaceId: { type: "string", format: "uuid" },
      ownerUserId: { type: "string", format: "uuid" },
      proposedByActorKind: { type: "string", enum: ["human", "agent"] },
      proposedByAgentId: {
        oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
      },
      kind: { type: "string", enum: [...MEMORY_PROPOSAL_KINDS] },
      targetMemoryId: {
        oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
      },
      baseMemoryVersion: {
        oneOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
      },
      proposedContent: {
        type: "string",
        minLength: 1,
        maxLength: MEMORY_CONTENT_LIMITS.maximumCharacters,
      },
      proposedScope: memoryScopeSchema,
      proposedMetadata: { type: "object", additionalProperties: true },
      evidenceMemoryIds: {
        type: "array",
        maxItems: MAXIMUM_MEMORY_PROPOSAL_EVIDENCE,
        items: { type: "string", format: "uuid" },
      },
      evidenceObservationIds: {
        type: "array",
        maxItems: MAXIMUM_MEMORY_PROPOSAL_EVIDENCE,
        items: { type: "string", format: "uuid" },
      },
      codeEvidence: {
        type: "array",
        maxItems: MAXIMUM_MEMORY_PROPOSAL_EVIDENCE,
        items: { $ref: "#/components/schemas/MemoryProposalCodeEvidence" },
      },
      status: { type: "string", enum: [...MEMORY_PROPOSAL_STATUSES] },
      reviewedByUserId: {
        oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
      },
      acceptedMemoryId: {
        oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
      },
      createdAt: { type: "string", format: "date-time" },
      reviewedAt: {
        oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
      },
    },
  },
  MemoryProposalReviewResult: {
    type: "object",
    additionalProperties: false,
    required: ["proposal", "memory"],
    properties: {
      proposal: { $ref: "#/components/schemas/MemoryProposal" },
      memory: { oneOf: [{ $ref: "#/components/schemas/Memory" }, { type: "null" }] },
    },
  },
};
