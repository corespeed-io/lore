import {
  jsonResponse,
  memoryIdParameter,
  requestBody,
  timestampProperties,
  workspaceHeader,
} from "@/server/openapi/shared";
import { CODE_EVIDENCE_RELATIONSHIPS, CODE_EVIDENCE_VALIDATION_STATES } from "./evidence-contract";
import {
  CODE_DEPENDENCY_DIRECTIONS,
  DEFAULT_CODE_DEPENDENCY_RESULTS,
  DEFAULT_CODE_INDEX_JOB_LIST,
  MAXIMUM_CODE_DEPENDENCY_RESULTS,
  MAXIMUM_CODE_INDEX_JOB_LIST,
  MAXIMUM_CODE_SEARCH_RESULTS,
} from "./indexing/protocol";
import { CODE_SEARCH_CHANNELS } from "./indexing/types";
import {
  CODE_QUERY_MAXIMUM_LENGTH,
  CODE_SOURCE_REF_MAXIMUM_LENGTH,
  CODE_SYMBOL_MAXIMUM_LENGTH,
  COMMIT_OID_JSON_PATTERN,
  REPOSITORY_KEY_MAXIMUM_LENGTH,
  REPOSITORY_PATH_MAXIMUM_LENGTH,
} from "./indexing/validation";

export const codeEvidenceRelationshipSchema = {
  type: "string",
  enum: [...CODE_EVIDENCE_RELATIONSHIPS],
} as const;

export const codeEvidenceValidationStateSchema = {
  type: "string",
  enum: [...CODE_EVIDENCE_VALIDATION_STATES],
} as const;

export const commitOidSchema = { type: "string", pattern: COMMIT_OID_JSON_PATTERN } as const;
export const repositoryKeySchema = {
  type: "string",
  minLength: 1,
  maxLength: REPOSITORY_KEY_MAXIMUM_LENGTH,
} as const;
export const repositoryPathSchema = {
  type: "string",
  minLength: 1,
  maxLength: REPOSITORY_PATH_MAXIMUM_LENGTH,
} as const;
export const codeQuerySchema = {
  type: "string",
  minLength: 1,
  maxLength: CODE_QUERY_MAXIMUM_LENGTH,
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
          schema: repositoryKeySchema,
        },
        {
          name: "commit_oid",
          in: "query",
          required: true,
          schema: commitOidSchema,
        },
        {
          name: "q",
          in: "query",
          required: true,
          schema: codeQuerySchema,
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: MAXIMUM_CODE_SEARCH_RESULTS },
        },
        {
          name: "path_prefix",
          in: "query",
          schema: repositoryPathSchema,
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
          schema: repositoryKeySchema,
        },
        {
          name: "commit_oid",
          in: "query",
          required: true,
          schema: commitOidSchema,
        },
        {
          name: "direction",
          in: "query",
          required: true,
          schema: { type: "string", enum: [...CODE_DEPENDENCY_DIRECTIONS] },
        },
        {
          name: "symbol",
          in: "query",
          schema: { type: "string", minLength: 1, maxLength: CODE_SYMBOL_MAXIMUM_LENGTH },
        },
        {
          name: "path",
          in: "query",
          schema: repositoryPathSchema,
        },
        {
          name: "limit",
          in: "query",
          schema: {
            type: "integer",
            minimum: 1,
            maximum: MAXIMUM_CODE_DEPENDENCY_RESULTS,
            default: DEFAULT_CODE_DEPENDENCY_RESULTS,
          },
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
          schema: {
            type: "integer",
            minimum: 1,
            maximum: MAXIMUM_CODE_INDEX_JOB_LIST,
            default: DEFAULT_CODE_INDEX_JOB_LIST,
          },
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
        items: { type: "string", enum: [...CODE_SEARCH_CHANNELS] },
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
      commitOid: commitOidSchema,
      direction: { type: "string", enum: [...CODE_DEPENDENCY_DIRECTIONS] },
      subject: { $ref: "#/components/schemas/CodeGraphLocator" },
      edges: {
        type: "array",
        maxItems: MAXIMUM_CODE_DEPENDENCY_RESULTS,
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
      commitOid: commitOidSchema,
      direction: { type: "string", enum: [...CODE_DEPENDENCY_DIRECTIONS] },
      candidates: {
        type: "array",
        minItems: 2,
        maxItems: MAXIMUM_CODE_DEPENDENCY_RESULTS,
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
      commitOid: commitOidSchema,
      direction: { type: "string", enum: [...CODE_DEPENDENCY_DIRECTIONS] },
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
      repositoryKey: repositoryKeySchema,
      commitOid: commitOidSchema,
      sourceRef: { type: "string", minLength: 1, maxLength: CODE_SOURCE_REF_MAXIMUM_LENGTH },
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
        enum: [...CODE_EVIDENCE_RELATIONSHIPS],
      },
    },
  },
  RevalidateMemoryCodeEvidenceInput: {
    type: "object",
    additionalProperties: false,
    required: ["repositoryKey", "commitOid"],
    properties: {
      repositoryKey: repositoryKeySchema,
      commitOid: commitOidSchema,
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
        enum: [...CODE_EVIDENCE_RELATIONSHIPS],
      },
      validationState: {
        type: "string",
        enum: [...CODE_EVIDENCE_VALIDATION_STATES],
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
