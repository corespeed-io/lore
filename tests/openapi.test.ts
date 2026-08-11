import { expect, test } from "vitest";
import { loreOpenApiDocument } from "@/lib/openapi";

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
      "/api/v1/evaluations/runs/{runId}",
      "/api/v1/evaluations/suites",
      "/api/v1/evaluations/suites/{suiteId}/runs",
      "/api/v1/episodes",
      "/api/v1/episodes/{episodeId}",
      "/api/v1/graph",
      "/api/v1/memories",
      "/api/v1/memories/{memoryId}",
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
  expect(document.components.schemas.Error.properties.code.enum).toEqual(
    expect.arrayContaining([
      "idempotency_conflict",
      "precondition_required",
      "proposal_capacity_exceeded",
      "proposal_review_conflict",
      "version_conflict",
      "workspace_export_limit_exceeded",
    ]),
  );
  expect(document.paths["/api/v1/workspaces/export"].get.responses).toHaveProperty("409");
  expect(document.components.schemas.Capabilities.properties.limits.properties).toEqual({
    episodeContentCharacters: { const: 1_000_000 },
    episodeMetadataCharacters: { const: 1_000_000 },
    episodeObservations: { const: 100 },
    memoryProposalEvidence: { const: 50 },
    memoryProposalList: { const: 100 },
    memoryProposalPending: { const: 100 },
    memoryProposalRetentionSeconds: { const: 2_592_000 },
    observationContentCharacters: { const: 100_000 },
    observationBatchRead: { const: 50 },
    workspaceArchiveLinks: { const: 50_000 },
    workspaceArchiveMemories: { const: 10_000 },
  });
  expect(document.components.schemas.Capabilities.properties.features.properties).toHaveProperty(
    "memoryProposals",
    { const: true },
  );
  expect(document.components.schemas.Capabilities.properties.features.properties).toHaveProperty(
    "observationEvidence",
    { const: true },
  );
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
