import { jsonResponse, requestBody, workspaceHeader } from "@/server/openapi/shared";

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
      query: { type: "string", minLength: 1, maxLength: 10_000 },
      memoryQuery: { type: "string", minLength: 1, maxLength: 10_000 },
      codeQuery: { type: "string", minLength: 1, maxLength: 2_000 },
      repositoryKey: { type: "string", minLength: 1, maxLength: 512 },
      commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
      route: {
        type: "string",
        enum: ["auto", "both", "code-only", "memory-only"],
        default: "auto",
      },
      memoryLimit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      codeLimit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      scope: { type: "string", enum: ["shared", "private"] },
      metadata: { type: "object", additionalProperties: true },
      pathPrefix: { type: "string", minLength: 1, maxLength: 1_024 },
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
        enum: ["blast-radius", "change", "current-code", "memory-recall", "rationale", "unknown"],
      },
      route: {
        type: "string",
        enum: ["abstain", "both", "code-only", "memory-only"],
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
      scope: { type: "string", enum: ["shared", "private"] },
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
      commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
      path: { type: "string" },
      symbol: { oneOf: [{ type: "string" }, { type: "null" }] },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      score: { type: "number" },
      matchedChannels: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", enum: ["symbol", "literal", "lexical", "path"] },
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
      relationship: {
        type: "string",
        enum: ["supports", "contradicts", "implements", "rationale"],
      },
      localState: {
        type: "string",
        enum: ["current", "moved", "changed", "deleted", "ambiguous", "unverifiable"],
      },
      citedCommitOid: {
        type: "string",
        pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$",
      },
      citedPath: { type: "string" },
      validatedCommitOid: {
        oneOf: [{ type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" }, { type: "null" }],
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
        enum: ["affected", "possibly_affected", "unaffected", "unknown"],
      },
      changes: {
        type: "array",
        maxItems: 251,
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
      memoryCandidates: { type: "integer", minimum: 0, maximum: 10 },
      codeCandidates: { type: "integer", minimum: 0, maximum: 20 },
      anchorCandidates: { type: "integer", minimum: 0, maximum: 25 },
      requestedCommitOid: {
        oneOf: [{ type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" }, { type: "null" }],
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
        enum: ["abstain", "both", "code-only", "memory-only"],
      },
      memories: {
        type: "array",
        maxItems: 10,
        items: { $ref: "#/components/schemas/RetrievedMemoryContext" },
      },
      code: {
        type: "array",
        maxItems: 20,
        items: { $ref: "#/components/schemas/RetrievedCodeContext" },
      },
      anchors: {
        type: "array",
        maxItems: 25,
        items: { $ref: "#/components/schemas/RetrievedAnchorContext" },
      },
      conflicts: { type: "array", items: { type: "string" } },
      receipt: { $ref: "#/components/schemas/ContextRetrievalReceipt" },
    },
  },
};
