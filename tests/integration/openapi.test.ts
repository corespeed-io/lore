import { MEMORY_LIST_LIMITS, MEMORY_SEARCH_LIMITS } from "@corespeed/lore-core";
import { expect, test } from "vitest";
import { LORE_ERROR_CODES } from "@/server/errors";
import { loreOpenApiDocument } from "@/server/openapi/document";
import { idempotencyHeader } from "@/server/openapi/shared";

test("OpenAPI publishes every stable v1 route and bounded error codes", () => {
  const document = loreOpenApiDocument() as {
    components: {
      schemas: {
        Capabilities: {
          properties: {
            features: {
              properties: {
                memoryProposals: { const: true };
                observationEvidence: { const: true };
              };
            };
            memoryChunking: {
              type: "object";
              additionalProperties: false;
              required: string[];
              properties: {
                revision: { const: string };
                maximumCharacters: { const: number };
                overlapCharacters: { const: number };
              };
            };
            limits: {
              properties: {
                workspaceArchiveLinks: { const: number };
                workspaceArchiveMemories: { const: number };
                memoryProposalEvidence: { const: number };
                memoryProposalList: { const: number };
                memoryProposalPending: { const: number };
                episodeObservations: { const: number };
                episodeContentCharacters: { const: number };
                episodeMetadataCharacters: { const: number };
                observationContentCharacters: { const: number };
                observationBatchRead: { const: number };
              };
            };
          };
        };
        CreateMemoryProposalUpdateInput: { anyOf: Array<{ $ref: string }> };
        Error: { properties: { code: { enum: string[] } } };
        IssuedAgentCredential: {
          properties: { token: { type: string; readOnly: boolean } };
        };
        MemorySearchResult: {
          properties: { rerankScore: { type: string; minimum: number; maximum: number } };
        };
        CreateMemoryProposalCreateInput: {
          properties: { codeEvidence: { items: { $ref: string } } };
        };
        MemoryProposal: {
          required: readonly string[];
          properties: { codeEvidence: { items: { $ref: string } } };
        };
        MemoryProposalCodeEvidence: { required: readonly string[] };
        MemoryCodeEvidence: { required: readonly string[] };
        RetrieveContextInput: { required: readonly string[] };
        RetrievedContext: { required: readonly string[] };
        MemoryProposalUpdateContentInput: { required: readonly string[] };
        MemoryProposalUpdateMetadataInput: { required: readonly string[] };
        MemoryProposalUpdateScopeInput: { required: readonly string[] };
      };
    };
    openapi: string;
    paths: Record<string, Record<string, Record<string, unknown>>>;
    security: Array<Record<string, unknown>>;
  };
  expect(document.openapi).toBe("3.1.1");
  expect(Object.keys(document.paths).sort()).toEqual(
    [
      "/api/v1/actor",
      "/api/v1/agent-credentials/{credentialId}",
      "/api/v1/agents",
      "/api/v1/agents/{agentId}",
      "/api/v1/agents/{agentId}/credentials",
      "/api/v1/agents/{agentId}/grant",
      "/api/v1/capabilities",
      "/api/v1/code-evidence/{evidenceId}/revalidate",
      "/api/v1/code/dependencies",
      "/api/v1/code/index-jobs",
      "/api/v1/code/index-jobs/{jobId}",
      "/api/v1/code/search",
      "/api/v1/context/retrieve",
      "/api/v1/evaluations/runs/{runId}",
      "/api/v1/evaluations/suites",
      "/api/v1/evaluations/suites/{suiteId}/runs",
      "/api/v1/episodes",
      "/api/v1/episodes/{episodeId}",
      "/api/v1/graph",
      "/api/v1/memories",
      "/api/v1/memories/{memoryId}",
      "/api/v1/memories/{memoryId}/code-evidence",
      "/api/v1/memories/{memoryId}/links",
      "/api/v1/memories/{memoryId}/links/{targetMemoryId}",
      "/api/v1/memory-proposals",
      "/api/v1/memory-proposals/{proposalId}/review",
      "/api/v1/observations",
      "/api/v1/workspaces",
      "/api/v1/workspaces/export",
      "/api/v1/workspaces/import",
      "/livez",
      "/readyz",
    ].sort(),
  );
  // The Error code enum is closed: it is exactly the public vocabulary every domain
  // error, route literal, and SQLSTATE mapping draws its code from.
  expect([...document.components.schemas.Error.properties.code.enum].sort()).toEqual(
    [...LORE_ERROR_CODES].sort(),
  );
  expect([...document.components.schemas.Error.properties.code.enum].sort()).toEqual([
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
    "workspace_export_limit_exceeded",
  ]);
  expect(document.paths["/api/v1/workspaces/export"].get.responses).toHaveProperty("409");
  expect(document.paths["/api/v1/code/dependencies"].get).toMatchObject({
    operationId: "queryCodeDependencies",
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CodeDependencyQueryResult" },
          },
        },
      },
    },
  });
  expect(document.paths["/api/v1/context/retrieve"].post).toMatchObject({
    operationId: "retrieveContext",
    requestBody: {
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/RetrieveContextInput" },
        },
      },
    },
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RetrievedContext" },
          },
        },
      },
    },
  });
  expect(document.components.schemas.Capabilities.properties.limits.properties).toEqual({
    codeIndexArtifacts: { const: 100_000 },
    codeIndexFiles: { const: 20_000 },
    codeIndexSourceBytes: { const: 134_217_728 },
    codeDependencyResults: { const: 200 },
    codeSearchResults: { const: 100 },
    episodeContentCharacters: { const: 1_000_000 },
    episodeMetadataCharacters: { const: 1_000_000 },
    episodeObservations: { const: 100 },
    graphLinks: { const: 40_000 },
    memoryLinkKindsPerPair: { const: 16 },
    memoryLinkList: { const: 100 },
    memoryLinkMetadataCharacters: { const: 1_000 },
    memoryLinksPerOwner: { const: 50_000 },
    memoryLinksPerSource: { const: 1_000 },
    memoryLinksPerTarget: { const: 1_000 },
    memoryProposalEvidence: { const: 50 },
    memoryProposalList: { const: 100 },
    memoryProposalPending: { const: 100 },
    memoryProposalRetentionSeconds: { const: 2_592_000 },
    memoryContentRecommendedCharacters: { const: 8_000 },
    memoryContentMaximumCharacters: { const: 32_000 },
    memoryMaximumChunks: { const: 64 },
    observationContentCharacters: { const: 100_000 },
    observationBatchRead: { const: 50 },
    workspaceArchiveLinks: { const: 50_000 },
    workspaceArchiveMemories: { const: 10_000 },
  });
  expect(document.components.schemas.Capabilities.properties.memoryChunking).toEqual({
    type: "object",
    additionalProperties: false,
    required: ["revision", "maximumCharacters", "overlapCharacters"],
    properties: {
      revision: { const: "lore-memory-chunking-v2" },
      maximumCharacters: { const: 1_200 },
      overlapCharacters: { const: 0 },
    },
  });
  expect(document.components.schemas.Capabilities.properties.features.properties).toHaveProperty(
    "memoryProposals",
    { const: true },
  );
  expect(document.components.schemas.Capabilities.properties.features.properties).toHaveProperty(
    "observationEvidence",
    { const: true },
  );
  expect(document.components.schemas.Capabilities.properties.features.properties).toMatchObject({
    codeDependencies: { const: true },
    codeEvidence: { const: true },
    codeIndex: { const: true },
    memoryLinks: { const: true },
  });
  expect(document.components.schemas.CreateMemoryProposalUpdateInput.anyOf).toEqual([
    { $ref: "#/components/schemas/MemoryProposalUpdateContentInput" },
    { $ref: "#/components/schemas/MemoryProposalUpdateScopeInput" },
    { $ref: "#/components/schemas/MemoryProposalUpdateMetadataInput" },
  ]);
  expect(document.components.schemas.MemoryProposalUpdateContentInput.required).toContain(
    "content",
  );
  expect(document.components.schemas.MemoryProposalUpdateScopeInput.required).toContain("scope");
  expect(document.components.schemas.MemoryProposalUpdateMetadataInput.required).toContain(
    "metadata",
  );
  expect(
    document.components.schemas.CreateMemoryProposalCreateInput.properties.codeEvidence.items.$ref,
  ).toBe("#/components/schemas/ProposeMemoryCodeEvidenceInput");
  expect(document.components.schemas.MemoryProposal.required).toContain("codeEvidence");
  expect(document.components.schemas.MemoryProposal.properties.codeEvidence.items.$ref).toBe(
    "#/components/schemas/MemoryProposalCodeEvidence",
  );
  expect(document.components.schemas.MemoryProposalCodeEvidence.required).toContain(
    "citedDeclarationChunkOrdinal",
  );
  expect(document.components.schemas.MemoryProposalCodeEvidence.required).toContain(
    "citedDeclarationContextSha256",
  );
  expect(document.components.schemas.MemoryCodeEvidence.required).toContain(
    "citedDeclarationChunkOrdinal",
  );
  expect(document.components.schemas.MemoryCodeEvidence.required).toContain(
    "citedDeclarationContextSha256",
  );
  expect(document.paths["/api/v1/memory-proposals/{proposalId}/review"]).toMatchObject({
    post: { responses: { "200": { headers: { ETag: { schema: { type: "string" } } } } } },
  });
  expect(document.components.schemas.MemorySearchResult.properties.rerankScore).toEqual(
    expect.objectContaining({ type: "number", minimum: 0, maximum: 1 }),
  );
  expect(document.security).toEqual(
    expect.arrayContaining([
      { agentBearer: [] },
      { basicAuth: [] },
      { cloudflareAccessHeader: [] },
    ]),
  );
  expect(document.paths["/livez"].get.security).toEqual([]);
  expect(document.paths["/readyz"].get.security).toEqual([]);
  expect(document.paths["/api/v1/capabilities"].get).toMatchObject({
    security: expect.arrayContaining([{ agentBearer: [] }, { basicAuth: [] }]),
    parameters: [
      expect.objectContaining({ name: "x-lore-workspace-id", in: "header", required: true }),
    ],
  });
  expect(document.paths["/api/v1/actor"].get).toMatchObject({
    security: expect.arrayContaining([{ basicAuth: [] }]),
    parameters: [
      expect.objectContaining({ name: "x-lore-workspace-id", in: "header", required: true }),
    ],
    responses: { "200": expect.any(Object) },
  });
  expect(document.paths["/api/v1/memories/{memoryId}"].patch.requestBody).toMatchObject({
    required: true,
  });
  expect(document.paths["/api/v1/agents/{agentId}/credentials"]).toMatchObject({
    get: { operationId: "listAgentCredentials" },
    post: { operationId: "issueAgentCredential" },
  });
  expect(document.paths["/api/v1/agents/{agentId}"]).toMatchObject({
    patch: {
      operationId: "updateAgent",
      security: expect.arrayContaining([{ basicAuth: [] }]),
      requestBody: { required: true },
      responses: { "200": expect.any(Object), "404": expect.any(Object) },
    },
    delete: {
      operationId: "deleteAgent",
      security: expect.arrayContaining([{ basicAuth: [] }]),
      responses: { "204": expect.any(Object), "409": expect.any(Object) },
    },
  });
  expect(document.paths["/api/v1/agents/{agentId}/grant"].put).toMatchObject({
    operationId: "setAgentGrant",
    requestBody: { required: true },
  });
  // A Link is addressed by its natural key, so its writes are idempotent without a key.
  const linkPath = document.paths["/api/v1/memories/{memoryId}/links/{targetMemoryId}"];
  expect(linkPath.put).toMatchObject({
    operationId: "putMemoryLink",
    requestBody: { required: true },
    responses: { "200": expect.any(Object), "201": expect.any(Object), "404": expect.any(Object) },
  });
  expect(linkPath.delete).toMatchObject({
    operationId: "deleteMemoryLink",
    responses: { "204": expect.any(Object), "404": expect.any(Object) },
  });
  for (const operation of [linkPath.put, linkPath.delete]) {
    const parameters = operation.parameters as Array<{ name: string; schema: unknown }>;
    expect(parameters.map((parameter) => parameter.name)).not.toContain("Idempotency-Key");
    expect(parameters.find((parameter) => parameter.name === "kind")?.schema).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 64,
      default: "related",
    });
  }
  expect(document.components.schemas.IssuedAgentCredential.properties.token).toEqual({
    type: "string",
    readOnly: true,
  });
  expect(
    document.paths["/api/v1/memories"].get.parameters as Array<Record<string, unknown>>,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "scope",
        in: "query",
        schema: { type: "string", enum: ["shared", "private"] },
      }),
      expect.objectContaining({
        name: "updated_after",
        in: "query",
        schema: { type: "string", format: "date-time" },
      }),
      expect.objectContaining({
        name: "updated_before",
        in: "query",
        schema: { type: "string", format: "date-time" },
      }),
      expect.objectContaining({
        name: "metadata",
        in: "query",
        schema: { type: "string", maxLength: 10_000 },
      }),
    ]),
  );
  expect(document.paths["/api/v1/workspaces/import"].post.requestBody).toMatchObject({
    required: true,
  });
  expect(document.paths["/api/v1/workspaces"].post.requestBody).toMatchObject({ required: true });
  expect(document.paths["/api/v1/agents"].post.requestBody).toMatchObject({ required: true });
  expect(document.paths["/api/v1/evaluations/suites"].post.requestBody).toMatchObject({
    required: true,
  });
});

test("OpenAPI publishes the Idempotency-Key pattern the server enforces", () => {
  const pattern = new RegExp(idempotencyHeader.schema.pattern);
  for (const accepted of ["a", "retry-1", "!~", "x".repeat(128)]) {
    expect(pattern.test(accepted), accepted).toBe(true);
  }
  for (const rejected of ["", "with space", "tab\t", "é", "x".repeat(129)]) {
    expect(pattern.test(rejected), rejected).toBe(false);
  }
});

test("the Memory list and search share one published limit bound", () => {
  // GET /api/v1/memories lists or searches through one `limit` parameter, so it can
  // publish only one maximum; the route enforces each mode's own engine bound.
  expect(MEMORY_SEARCH_LIMITS.maximumLimit).toBe(MEMORY_LIST_LIMITS.maximumLimit);
  const document = loreOpenApiDocument() as {
    paths: {
      "/api/v1/memories": {
        get: { parameters: Array<{ name?: string; schema?: Record<string, unknown> }> };
      };
    };
  };
  const limit = document.paths["/api/v1/memories"].get.parameters.find(
    (parameter) => parameter.name === "limit",
  );
  expect(limit?.schema?.maximum).toBe(MEMORY_SEARCH_LIMITS.maximumLimit);
  // One `default` would be wrong for one of the two modes, so neither uses it.
  expect(limit?.schema).not.toHaveProperty("default");
  expect(limit?.schema?.["x-lore-listDefault"]).toBe(MEMORY_LIST_LIMITS.defaultLimit);
  expect(limit?.schema?.["x-lore-searchDefault"]).toBe(MEMORY_SEARCH_LIMITS.defaultLimit);
});
