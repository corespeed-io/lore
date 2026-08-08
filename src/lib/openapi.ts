import { LORE_API_VERSION } from "./operations";

const errorSchema = {
  type: "object",
  required: ["code", "error"],
  properties: {
    code: {
      type: "string",
      enum: [
        "access_denied",
        "authentication_required",
        "idempotency_conflict",
        "internal_error",
        "invalid_archive",
        "invalid_request",
        "not_found",
        "precondition_required",
        "version_conflict",
      ],
    },
    error: { type: "string" },
  },
} as const;

const memorySchema = {
  type: "object",
  required: [
    "id",
    "workspaceId",
    "ownerUserId",
    "scope",
    "content",
    "metadata",
    "version",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    workspaceId: { type: "string", format: "uuid" },
    ownerUserId: { type: "string", format: "uuid" },
    createdByAgentId: { oneOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
    scope: { type: "string", enum: ["shared", "private"] },
    content: { type: "string", maxLength: 1_000_000 },
    metadata: { type: "object", additionalProperties: true },
    version: { type: "integer", minimum: 1 },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const workspaceHeader = {
  name: "x-lore-workspace-id",
  in: "header",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", minLength: 1, maxLength: 128 },
} as const;

export function loreOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.1",
    info: {
      title: "Lore Portable Core",
      version: LORE_API_VERSION,
      description: "RLS-enforced Memory storage, retrieval, and portability.",
    },
    servers: [{ url: "/" }],
    paths: {
      "/api/v1/workspaces": {
        get: {
          operationId: "listWorkspaces",
          responses: { "200": { description: "Workspaces available to the authenticated User" } },
        },
        post: {
          operationId: "createWorkspace",
          responses: { "201": { description: "Created Workspace" } },
        },
      },
      "/api/v1/memories": {
        get: {
          operationId: "listMemories",
          parameters: [
            workspaceHeader,
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description:
                "Actor-visible Memories. x-lore-next-cursor is present when another page may exist.",
              headers: { "x-lore-next-cursor": { schema: { type: "string" } } },
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Memory" } },
                },
              },
            },
          },
        },
        post: {
          operationId: "createMemory",
          parameters: [workspaceHeader, idempotencyHeader],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["content"],
                  properties: {
                    content: { type: "string", minLength: 1, maxLength: 1_000_000 },
                    scope: { type: "string", enum: ["shared", "private"], default: "shared" },
                    metadata: { type: "object", additionalProperties: true },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Created Memory" },
            "409": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/v1/memories/{memoryId}": {
        get: {
          operationId: "getMemory",
          parameters: [
            workspaceHeader,
            {
              name: "memoryId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": { description: "Memory with a strong ETag" },
            "404": { $ref: "#/components/responses/Error" },
          },
        },
        patch: {
          operationId: "updateMemory",
          parameters: [
            workspaceHeader,
            idempotencyHeader,
            {
              name: "If-Match",
              in: "header",
              required: true,
              schema: { type: "string", pattern: '^"memory-v[1-9][0-9]*"$' },
            },
            {
              name: "memoryId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": { description: "Updated Memory" },
            "412": { $ref: "#/components/responses/Error" },
            "428": { $ref: "#/components/responses/Error" },
          },
        },
        delete: {
          operationId: "deleteMemory",
          parameters: [
            workspaceHeader,
            idempotencyHeader,
            { name: "If-Match", in: "header", required: true, schema: { type: "string" } },
            {
              name: "memoryId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "204": { description: "Deleted" },
            "412": { $ref: "#/components/responses/Error" },
            "428": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/v1/graph": {
        get: {
          operationId: "getMemoryGraph",
          parameters: [workspaceHeader],
          responses: { "200": { description: "Actor-visible graph with authorized endpoints" } },
        },
      },
      "/api/v1/agents": {
        get: {
          operationId: "listAgents",
          parameters: [workspaceHeader],
          responses: { "200": { description: "User-private Agents" } },
        },
        post: {
          operationId: "createAgent",
          parameters: [workspaceHeader],
          responses: { "201": { description: "Created Agent" } },
        },
      },
      "/api/v1/agents/{agentId}/credentials": {
        post: {
          operationId: "issueAgentCredential",
          parameters: [
            workspaceHeader,
            {
              name: "agentId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: { "201": { description: "One-time Agent credential" } },
        },
      },
      "/api/v1/agents/{agentId}/grant": {
        delete: {
          operationId: "revokeAgentGrant",
          parameters: [
            workspaceHeader,
            {
              name: "agentId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: { "204": { description: "Grant revoked" } },
        },
      },
      "/api/v1/agent-credentials/{credentialId}": {
        delete: {
          operationId: "revokeAgentCredential",
          parameters: [
            workspaceHeader,
            {
              name: "credentialId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: { "204": { description: "Credential revoked" } },
        },
      },
      "/api/v1/evaluations/suites": {
        get: {
          operationId: "listEvaluationSuites",
          parameters: [workspaceHeader],
          responses: { "200": { description: "Workspace Evaluation Suites" } },
        },
        post: {
          operationId: "createEvaluationSuite",
          parameters: [workspaceHeader],
          responses: { "201": { description: "Created Evaluation Suite" } },
        },
      },
      "/api/v1/evaluations/suites/{suiteId}/runs": {
        post: {
          operationId: "runEvaluationSuite",
          parameters: [
            workspaceHeader,
            {
              name: "suiteId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: { "201": { description: "Completed Evaluation Run" } },
        },
      },
      "/api/v1/evaluations/runs/{runId}": {
        get: {
          operationId: "getEvaluationRun",
          parameters: [
            workspaceHeader,
            {
              name: "runId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: { "200": { description: "Evaluation Run and results" } },
        },
      },
      "/api/v1/workspaces/export": {
        get: {
          operationId: "exportWorkspace",
          parameters: [workspaceHeader],
          responses: { "200": { description: "Versioned actor-visible Workspace archive" } },
        },
      },
      "/api/v1/workspaces/import": {
        post: {
          operationId: "importWorkspace",
          parameters: [workspaceHeader],
          responses: { "200": { description: "Dry-run or completed import" } },
        },
      },
      "/api/v1/capabilities": {
        get: {
          operationId: "getCapabilities",
          responses: { "200": { description: "Deployment capabilities without tenant data" } },
        },
      },
      "/livez": {
        get: {
          operationId: "getLiveness",
          responses: { "200": { description: "Process is live" } },
        },
      },
      "/readyz": {
        get: {
          operationId: "getReadiness",
          responses: {
            "200": { description: "Ready or degraded" },
            "503": { description: "Not ready" },
          },
        },
      },
    },
    components: {
      schemas: { Error: errorSchema, Memory: memorySchema },
      responses: {
        Error: {
          description: "Stable Lore error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
  };
}
