import {
  jsonResponse,
  memoryIdParameter,
  requestBody,
  timestampProperties,
  workspaceHeader,
} from "@/server/openapi/shared";

export const codeEvidenceRelationshipSchema = {
  type: "string",
  enum: ["supports", "contradicts", "implements", "rationale"],
} as const;

export const codePaths = {
  "/api/v1/code/search": {
    get: {
      operationId: "searchCode",
      parameters: [
        workspaceHeader,
        {
          name: "repository_key",
          in: "query",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 512 },
        },
        {
          name: "commit_oid",
          in: "query",
          required: true,
          schema: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
        },
        {
          name: "q",
          in: "query",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 2_000 },
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100 },
        },
        {
          name: "path_prefix",
          in: "query",
          schema: { type: "string", minLength: 1, maxLength: 1_024 },
        },
      ],
      responses: {
        "200": jsonResponse("RLS-visible exact-revision Code Artifacts", {
          type: "array",
          items: { $ref: "#/components/schemas/CodeArtifact" },
        }),
      },
    },
  },
  "/api/v1/code/dependencies": {
    get: {
      operationId: "queryCodeDependencies",
      description:
        "Return bounded callers or callees from one Workspace-visible repository, exact full commit OID, and active Code Index Generation. Exactly one of symbol or path is required.",
      parameters: [
        workspaceHeader,
        {
          name: "repository_key",
          in: "query",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 512 },
        },
        {
          name: "commit_oid",
          in: "query",
          required: true,
          schema: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
        },
        {
          name: "direction",
          in: "query",
          required: true,
          schema: { type: "string", enum: ["callers", "callees"] },
        },
        {
          name: "symbol",
          in: "query",
          schema: { type: "string", minLength: 1, maxLength: 1_600 },
        },
        {
          name: "path",
          in: "query",
          schema: { type: "string", minLength: 1, maxLength: 1_024 },
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
      ],
      responses: {
        "200": jsonResponse("Bounded exact-revision Code Dependency result", {
          $ref: "#/components/schemas/CodeDependencyQueryResult",
        }),
        "400": { $ref: "#/components/responses/Error" },
        "403": { $ref: "#/components/responses/Error" },
      },
    },
  },
  "/api/v1/code/index-jobs/{jobId}": {
    get: {
      operationId: "getCodeIndexJob",
      parameters: [
        workspaceHeader,
        {
          name: "jobId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": jsonResponse("Safe Code Index job status", {
          $ref: "#/components/schemas/CodeIndexJob",
        }),
      },
    },
  },
  "/api/v1/code/index-jobs": {
    get: {
      operationId: "listCodeIndexJobs",
      parameters: [
        workspaceHeader,
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
      ],
      responses: {
        "200": jsonResponse("Bounded newest-first Code Index job status for the Workspace", {
          type: "array",
          items: { $ref: "#/components/schemas/CodeIndexJob" },
        }),
        "400": { $ref: "#/components/responses/Error" },
        "403": { $ref: "#/components/responses/Error" },
      },
    },
    post: {
      operationId: "enqueueCodeIndex",
      parameters: [workspaceHeader],
      requestBody: requestBody({ $ref: "#/components/schemas/EnqueueCodeIndexInput" }),
      responses: {
        "202": jsonResponse("Queued exact revision from an operator-configured repository", {
          $ref: "#/components/schemas/CodeIndexJob",
        }),
      },
    },
  },
  "/api/v1/memories/{memoryId}/code-evidence": {
    get: {
      operationId: "listMemoryCodeEvidence",
      parameters: [workspaceHeader, memoryIdParameter],
      responses: {
        "200": jsonResponse("Typed Code Evidence visible with the Memory", {
          type: "array",
          items: { $ref: "#/components/schemas/MemoryCodeEvidence" },
        }),
      },
    },
    post: {
      operationId: "citeMemoryCodeEvidence",
      parameters: [workspaceHeader, memoryIdParameter],
      requestBody: requestBody({ $ref: "#/components/schemas/CiteMemoryCodeEvidenceInput" }),
      responses: {
        "201": jsonResponse("Created immutable Code Evidence citation", {
          $ref: "#/components/schemas/MemoryCodeEvidence",
        }),
      },
    },
  },
  "/api/v1/code-evidence/{evidenceId}/revalidate": {
    post: {
      operationId: "revalidateMemoryCodeEvidence",
      parameters: [
        workspaceHeader,
        {
          name: "evidenceId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: requestBody({
        $ref: "#/components/schemas/RevalidateMemoryCodeEvidenceInput",
      }),
      responses: {
        "200": jsonResponse("Revalidated Code Evidence without changing Memory", {
          $ref: "#/components/schemas/MemoryCodeEvidence",
        }),
      },
    },
  },
};

export const codeSchemas = {
  CodeArtifactSymbol: {
    type: "object",
    additionalProperties: false,
    required: ["symbol", "symbolKey", "declarationKey"],
    properties: {
      symbol: { type: "string" },
      symbolKey: { type: "string" },
      declarationKey: { type: "string" },
    },
  },
  CodeArtifact: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "repositoryId",
      "revisionId",
      "generationId",
      "commitOid",
      "path",
      "language",
      "parser",
      "parseStatus",
      "kind",
      "symbol",
      "symbolKey",
      "declarationKey",
      "declarationChunkOrdinal",
      "symbols",
      "ordinal",
      "startLine",
      "endLine",
      "content",
      "contentSha256",
      "matchedChannels",
      "score",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      repositoryId: { type: "string", format: "uuid" },
      revisionId: { type: "string", format: "uuid" },
      generationId: { type: "string", format: "uuid" },
      commitOid: { type: "string" },
      path: { type: "string" },
      language: { type: "string" },
      parser: { type: "string", enum: ["tree_sitter", "text"] },
      parseStatus: { type: "string", enum: ["parsed", "recovered", "fallback"] },
      kind: { type: "string" },
      symbol: { oneOf: [{ type: "string" }, { type: "null" }] },
      symbolKey: { oneOf: [{ type: "string" }, { type: "null" }] },
      declarationKey: { oneOf: [{ type: "string" }, { type: "null" }] },
      declarationChunkOrdinal: {
        oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
      },
      symbols: {
        type: "array",
        items: { $ref: "#/components/schemas/CodeArtifactSymbol" },
      },
      ordinal: { type: "integer", minimum: 0 },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      content: { type: "string", maxLength: 6_000 },
      contentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      matchedChannels: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", enum: ["symbol", "literal", "lexical", "path"] },
      },
      score: { type: "number" },
    },
  },
  CodeGraphLocator: {
    type: "object",
    additionalProperties: false,
    required: ["artifactId", "path", "symbol", "symbolKey"],
    properties: {
      artifactId: {
        oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
      },
      path: { oneOf: [{ type: "string" }, { type: "null" }] },
      symbol: { oneOf: [{ type: "string" }, { type: "null" }] },
      symbolKey: { oneOf: [{ type: "string" }, { type: "null" }] },
    },
  },
  CodeDependencySite: {
    type: "object",
    additionalProperties: false,
    required: ["path", "startLine", "startColumn", "endLine", "endColumn"],
    properties: {
      path: { type: "string" },
      startLine: { type: "integer", minimum: 1 },
      startColumn: { type: "integer", minimum: 0 },
      endLine: { type: "integer", minimum: 1 },
      endColumn: { type: "integer", minimum: 0 },
    },
  },
  CodeDependencyEdge: {
    type: "object",
    additionalProperties: false,
    required: ["id", "kind", "resolution", "targetText", "from", "to", "site"],
    properties: {
      id: { type: "string", format: "uuid" },
      kind: { type: "string", enum: ["calls", "imports", "references"] },
      resolution: {
        type: "string",
        enum: ["resolved", "ambiguous", "unresolved"],
      },
      targetText: { type: "string", minLength: 1, maxLength: 1_600 },
      from: { $ref: "#/components/schemas/CodeGraphLocator" },
      to: { $ref: "#/components/schemas/CodeGraphLocator" },
      site: { $ref: "#/components/schemas/CodeDependencySite" },
    },
  },
  CodeDependencyQueryOk: {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "repositoryKey",
      "commitOid",
      "direction",
      "subject",
      "edges",
      "truncated",
    ],
    properties: {
      status: { const: "ok" },
      repositoryKey: { type: "string" },
      commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
      direction: { type: "string", enum: ["callers", "callees"] },
      subject: { $ref: "#/components/schemas/CodeGraphLocator" },
      edges: {
        type: "array",
        maxItems: 200,
        items: { $ref: "#/components/schemas/CodeDependencyEdge" },
      },
      truncated: { type: "boolean" },
    },
  },
  CodeDependencyQueryAmbiguous: {
    type: "object",
    additionalProperties: false,
    required: ["status", "repositoryKey", "commitOid", "direction", "candidates", "truncated"],
    properties: {
      status: { const: "ambiguous" },
      repositoryKey: { type: "string" },
      commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
      direction: { type: "string", enum: ["callers", "callees"] },
      candidates: {
        type: "array",
        minItems: 2,
        maxItems: 200,
        items: { $ref: "#/components/schemas/CodeGraphLocator" },
      },
      truncated: { type: "boolean" },
    },
  },
  CodeDependencyQueryNotFound: {
    type: "object",
    additionalProperties: false,
    required: ["status", "repositoryKey", "commitOid", "direction", "candidates"],
    properties: {
      status: { const: "not_found" },
      repositoryKey: { type: "string" },
      commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
      direction: { type: "string", enum: ["callers", "callees"] },
      candidates: {
        type: "array",
        maxItems: 0,
        items: { $ref: "#/components/schemas/CodeGraphLocator" },
      },
    },
  },
  CodeDependencyQueryResult: {
    oneOf: [
      { $ref: "#/components/schemas/CodeDependencyQueryOk" },
      { $ref: "#/components/schemas/CodeDependencyQueryAmbiguous" },
      { $ref: "#/components/schemas/CodeDependencyQueryNotFound" },
    ],
  },
  CodeIndexJob: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "repositoryId",
      "repositoryKey",
      "commitOid",
      "sourceRef",
      "indexerRevision",
      "status",
      "attemptCount",
      "maximumAttempts",
      "availableAt",
      "completedAt",
      "lastError",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      repositoryId: { type: "string", format: "uuid" },
      repositoryKey: { type: "string" },
      commitOid: { type: "string" },
      sourceRef: { oneOf: [{ type: "string" }, { type: "null" }] },
      indexerRevision: { type: "string" },
      status: {
        type: "string",
        enum: ["pending", "processing", "succeeded", "dead", "cancelled"],
      },
      attemptCount: { type: "integer", minimum: 0 },
      maximumAttempts: { type: "integer", minimum: 1 },
      availableAt: { type: "string", format: "date-time" },
      completedAt: {
        oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
      },
      lastError: { oneOf: [{ type: "string" }, { type: "null" }] },
      ...timestampProperties,
    },
  },
  EnqueueCodeIndexInput: {
    type: "object",
    additionalProperties: false,
    required: ["repositoryKey", "commitOid"],
    properties: {
      repositoryKey: { type: "string", minLength: 1, maxLength: 512 },
      commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
      sourceRef: { type: "string", minLength: 1, maxLength: 512 },
    },
  },
  CiteMemoryCodeEvidenceInput: {
    type: "object",
    additionalProperties: false,
    required: ["artifactId", "relationship"],
    properties: {
      artifactId: { type: "string", format: "uuid" },
      relationship: {
        type: "string",
        enum: ["supports", "contradicts", "implements", "rationale"],
      },
    },
  },
  RevalidateMemoryCodeEvidenceInput: {
    type: "object",
    additionalProperties: false,
    required: ["repositoryKey", "commitOid"],
    properties: {
      repositoryKey: { type: "string", minLength: 1, maxLength: 512 },
      commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
    },
  },
  MemoryCodeEvidence: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "memoryId",
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
      "validationState",
      "validatedRevisionId",
      "validatedGenerationId",
      "validatedArtifactId",
      "validatedCommitOid",
      "validatedPath",
      "createdByUserId",
      "createdByAgentId",
      "createdAt",
      "validatedAt",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      memoryId: { type: "string", format: "uuid" },
      repositoryId: { type: "string", format: "uuid" },
      citedRevisionId: { type: "string", format: "uuid" },
      citedGenerationId: { type: "string", format: "uuid" },
      citedArtifactId: { type: "string", format: "uuid" },
      citedCommitOid: { type: "string" },
      citedPath: { type: "string" },
      citedSymbolKey: { oneOf: [{ type: "string" }, { type: "null" }] },
      citedDeclarationKey: { oneOf: [{ type: "string" }, { type: "null" }] },
      citedDeclarationChunkOrdinal: {
        oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
      },
      citedDeclarationContextSha256: {
        oneOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }],
      },
      citedContentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      relationship: {
        type: "string",
        enum: ["supports", "contradicts", "implements", "rationale"],
      },
      validationState: {
        type: "string",
        enum: ["current", "moved", "changed", "deleted", "ambiguous", "unverifiable"],
      },
      validatedRevisionId: {
        oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
      },
      validatedGenerationId: {
        oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
      },
      validatedArtifactId: {
        oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
      },
      validatedCommitOid: { oneOf: [{ type: "string" }, { type: "null" }] },
      validatedPath: { oneOf: [{ type: "string" }, { type: "null" }] },
      createdByUserId: { type: "string", format: "uuid" },
      createdByAgentId: {
        oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
      },
      createdAt: { type: "string", format: "date-time" },
      validatedAt: { type: "string", format: "date-time" },
    },
  },
};
