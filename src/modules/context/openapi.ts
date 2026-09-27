import { MEMORY_SEARCH_LIMITS } from "@corespeed/lore-core";
import { CODE_SEARCH_CHANNELS } from "@/modules/code/indexing/types";
import {
  codeEvidenceRelationshipSchema,
  codeEvidenceValidationStateSchema,
  codeQuerySchema,
  commitOidSchema,
  repositoryKeySchema,
  repositoryPathSchema,
} from "@/modules/code/openapi";
import {
  jsonResponse,
  memoryScopeSchema,
  metadataSchema,
  requestBody,
  workspaceHeader,
} from "@/server/openapi/shared";
import {
  CONTEXT_RETRIEVAL_LIMITS,
  CONTEXT_RETRIEVAL_ROUTES,
  CONTEXTUAL_IMPACT_STATES,
  JOINT_EVIDENCE_INTENTS,
  JOINT_EVIDENCE_ROUTES,
  MAXIMUM_CONTEXT_ANCHORS,
  MAXIMUM_CONTEXTUAL_IMPACT_CHANGES,
} from "./policy";

const memoryQuerySchema = {
  type: "string",
  minLength: 1,
  maxLength: MEMORY_SEARCH_LIMITS.maximumQueryLength,
} as const;

export const contextPaths = {
  "/api/v1/context/retrieve": {
    post: {
      operationId: "retrieveContext",
      description:
        "Retrieve one bounded packet from Actor-visible Memory and an optional exact-revision Code Index. Code Evidence assessment is side-effect-free and does not update canonical Memory or citation state.",
      parameters: [workspaceHeader],
      requestBody: requestBody({ $ref: "#/components/schemas/RetrieveContextInput" }),
      responses: {
        "200": jsonResponse("Bounded, provenance-bearing Memory and Code context", {
          $ref: "#/components/schemas/RetrievedContext",
        }),
        "400": { $ref: "#/components/responses/Error" },
        "403": { $ref: "#/components/responses/Error" },
      },
    },
  },
};

export const contextSchemas = {
  RetrieveContextInput: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: memoryQuerySchema,
      memoryQuery: memoryQuerySchema,
      codeQuery: codeQuerySchema,
      repositoryKey: repositoryKeySchema,
      commitOid: commitOidSchema,
      route: {
        type: "string",
        enum: [...CONTEXT_RETRIEVAL_ROUTES],
        default: "auto",
      },
      memoryLimit: {
        type: "integer",
        minimum: 1,
        maximum: CONTEXT_RETRIEVAL_LIMITS.maximumMemoryLimit,
        default: CONTEXT_RETRIEVAL_LIMITS.defaultMemoryLimit,
      },
      codeLimit: {
        type: "integer",
        minimum: 1,
        maximum: CONTEXT_RETRIEVAL_LIMITS.maximumCodeLimit,
        default: CONTEXT_RETRIEVAL_LIMITS.defaultCodeLimit,
      },
      scope: memoryScopeSchema,
      metadata: metadataSchema,
      pathPrefix: repositoryPathSchema,
    },
  },
  ContextRetrievalPlan: {
    type: "object",
    additionalProperties: false,
    required: [
      "intent",
      "route",
      "needsAnchorExpansion",
      "needsContextualImpact",
      "needsLocalAssessment",
      "reasons",
    ],
    properties: {
      intent: {
        type: "string",
        enum: [...JOINT_EVIDENCE_INTENTS],
      },
      route: {
        type: "string",
        enum: [...JOINT_EVIDENCE_ROUTES],
      },
      needsAnchorExpansion: { type: "boolean" },
      needsContextualImpact: { type: "boolean" },
      needsLocalAssessment: { type: "boolean" },
      reasons: { type: "array", items: { type: "string" } },
    },
  },
  RetrievedMemoryContext: {
    type: "object",
    additionalProperties: false,
    required: ["id", "scope", "updatedAt", "score", "evidence"],
    properties: {
      id: { type: "string", format: "uuid" },
      scope: memoryScopeSchema,
      updatedAt: { type: "string", format: "date-time" },
      score: { type: "number" },
      rerankScore: { type: "number", minimum: 0, maximum: 1 },
      evidence: { type: "string" },
    },
  },
  RetrievedCodeContext: {
    type: "object",
    additionalProperties: false,
    required: [
      "artifactId",
      "commitOid",
      "path",
      "symbol",
      "startLine",
      "endLine",
      "score",
      "matchedChannels",
      "content",
    ],
    properties: {
      artifactId: { type: "string", format: "uuid" },
      commitOid: commitOidSchema,
      path: { type: "string" },
      symbol: { oneOf: [{ type: "string" }, { type: "null" }] },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      score: { type: "number" },
      matchedChannels: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", enum: [...CODE_SEARCH_CHANNELS] },
      },
      content: { type: "string", maxLength: 6_000 },
    },
  },
  RetrievedAnchorContext: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "memoryId",
      "relationship",
      "localState",
      "citedCommitOid",
      "citedPath",
      "validatedCommitOid",
      "validatedPath",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      memoryId: { type: "string", format: "uuid" },
      relationship: codeEvidenceRelationshipSchema,
      localState: codeEvidenceValidationStateSchema,
      citedCommitOid: commitOidSchema,
      citedPath: { type: "string" },
      validatedCommitOid: {
        oneOf: [commitOidSchema, { type: "null" }],
      },
      validatedPath: { oneOf: [{ type: "string" }, { type: "null" }] },
    },
  },
  ContextualImpactAssessment: {
    type: "object",
    additionalProperties: false,
    required: ["state", "changes"],
    properties: {
      state: {
        type: "string",
        enum: [...CONTEXTUAL_IMPACT_STATES],
      },
      changes: {
        type: "array",
        maxItems: MAXIMUM_CONTEXTUAL_IMPACT_CHANGES,
        items: { type: "string", maxLength: 2_500 },
      },
    },
  },
  ContextRetrievalReceipt: {
    type: "object",
    additionalProperties: false,
    required: [
      "memoryCandidates",
      "codeCandidates",
      "anchorCandidates",
      "requestedCommitOid",
      "memoryQuery",
      "codeQuery",
      "contextualImpact",
    ],
    properties: {
      memoryCandidates: {
        type: "integer",
        minimum: 0,
        maximum: CONTEXT_RETRIEVAL_LIMITS.maximumMemoryLimit,
      },
      codeCandidates: {
        type: "integer",
        minimum: 0,
        maximum: CONTEXT_RETRIEVAL_LIMITS.maximumCodeLimit,
      },
      anchorCandidates: { type: "integer", minimum: 0, maximum: MAXIMUM_CONTEXT_ANCHORS },
      requestedCommitOid: {
        oneOf: [commitOidSchema, { type: "null" }],
      },
      memoryQuery: { oneOf: [{ type: "string" }, { type: "null" }] },
      codeQuery: { oneOf: [{ type: "string" }, { type: "null" }] },
      contextualImpact: {
        oneOf: [{ $ref: "#/components/schemas/ContextualImpactAssessment" }, { type: "null" }],
      },
    },
  },
  RetrievedContext: {
    type: "object",
    additionalProperties: false,
    required: [
      "revision",
      "query",
      "plan",
      "deliveredRoute",
      "memories",
      "code",
      "anchors",
      "conflicts",
      "receipt",
    ],
    properties: {
      revision: { const: "joint-memory-code-v2" },
      query: { type: "string" },
      plan: { $ref: "#/components/schemas/ContextRetrievalPlan" },
      deliveredRoute: {
        type: "string",
        enum: [...JOINT_EVIDENCE_ROUTES],
      },
      memories: {
        type: "array",
        maxItems: CONTEXT_RETRIEVAL_LIMITS.maximumMemoryLimit,
        items: { $ref: "#/components/schemas/RetrievedMemoryContext" },
      },
      code: {
        type: "array",
        maxItems: CONTEXT_RETRIEVAL_LIMITS.maximumCodeLimit,
        items: { $ref: "#/components/schemas/RetrievedCodeContext" },
      },
      anchors: {
        type: "array",
        maxItems: MAXIMUM_CONTEXT_ANCHORS,
        items: { $ref: "#/components/schemas/RetrievedAnchorContext" },
      },
      conflicts: { type: "array", items: { type: "string" } },
      receipt: { $ref: "#/components/schemas/ContextRetrievalReceipt" },
    },
  },
};
