import { expect, test } from "vitest";
import { loreOpenApiDocument } from "@/lib/openapi";

test("OpenAPI publishes every stable v1 route and bounded error codes", () => {
  const document = loreOpenApiDocument() as {
    components: {
      schemas: {
        Capabilities: {
          properties: {
            limits: {
              properties: {
                workspaceArchiveLinks: { const: number };
                workspaceArchiveMemories: { const: number };
              };
            };
          };
        };
        Error: { properties: { code: { enum: string[] } } };
        IssuedAgentCredential: {
          properties: { token: { type: string; readOnly: boolean } };
        };
        MemorySearchResult: {
          properties: { rerankScore: { type: string; minimum: number; maximum: number } };
        };
      };
    };
    openapi: string;
    paths: Record<string, Record<string, Record<string, unknown>>>;
    security: Array<Record<string, unknown>>;
  };
  expect(document.openapi).toBe("3.1.1");
  expect(Object.keys(document.paths).sort()).toEqual(
    [
      "/api/v1/agent-credentials/{credentialId}",
      "/api/v1/actor",
      "/api/v1/agents",
      "/api/v1/agents/{agentId}/credentials",
      "/api/v1/agents/{agentId}/grant",
      "/api/v1/capabilities",
      "/api/v1/evaluations/runs/{runId}",
      "/api/v1/evaluations/suites",
      "/api/v1/evaluations/suites/{suiteId}/runs",
      "/api/v1/graph",
      "/api/v1/memories",
      "/api/v1/memories/{memoryId}",
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
      "version_conflict",
      "workspace_export_limit_exceeded",
    ]),
  );
  expect(document.paths["/api/v1/workspaces/export"].get.responses).toHaveProperty("409");
  expect(document.components.schemas.Capabilities.properties.limits.properties).toEqual({
    workspaceArchiveLinks: { const: 50_000 },
    workspaceArchiveMemories: { const: 10_000 },
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
