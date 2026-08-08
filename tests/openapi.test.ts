import { expect, test } from "vitest";
import { loreOpenApiDocument } from "@/lib/openapi";

test("OpenAPI publishes every stable v1 route and bounded error codes", () => {
  const document = loreOpenApiDocument() as {
    components: { schemas: { Error: { properties: { code: { enum: string[] } } } } };
    openapi: string;
    paths: Record<string, unknown>;
  };
  expect(document.openapi).toBe("3.1.1");
  expect(Object.keys(document.paths).sort()).toEqual(
    [
      "/api/v1/agent-credentials/{credentialId}",
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
    expect.arrayContaining(["idempotency_conflict", "precondition_required", "version_conflict"]),
  );
});
