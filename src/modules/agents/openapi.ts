import {
  agentIdParameter,
  humanSecurity,
  jsonResponse,
  requestBody,
  timestampProperties,
  workspaceHeader,
} from "@/server/openapi/shared";

export const agentsPaths = {
  "/api/v1/agents": {
    get: {
      operationId: "listAgents",
      security: humanSecurity,
      parameters: [workspaceHeader],
      responses: {
        "200": jsonResponse("User-private Agents", {
          type: "array",
          items: { $ref: "#/components/schemas/WorkspaceAgent" },
        }),
      },
    },
    post: {
      operationId: "createAgent",
      security: humanSecurity,
      parameters: [workspaceHeader],
      requestBody: requestBody({
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          permission: { type: "string", enum: ["read", "write"], default: "read" },
        },
      }),
      responses: {
        "201": jsonResponse("Created Agent", {
          $ref: "#/components/schemas/WorkspaceAgent",
        }),
      },
    },
  },
  "/api/v1/agents/{agentId}": {
    patch: {
      operationId: "updateAgent",
      security: humanSecurity,
      parameters: [workspaceHeader, agentIdParameter],
      requestBody: requestBody({ $ref: "#/components/schemas/UpdateAgentInput" }),
      responses: {
        "200": jsonResponse("Updated global Agent identity and status", {
          $ref: "#/components/schemas/WorkspaceAgent",
        }),
        "404": { $ref: "#/components/responses/Error" },
      },
    },
    delete: {
      operationId: "deleteAgent",
      security: humanSecurity,
      parameters: [workspaceHeader, agentIdParameter],
      responses: {
        "204": { description: "Disabled Agent, grants, and credentials deleted" },
        "404": { $ref: "#/components/responses/Error" },
        "409": { $ref: "#/components/responses/Error" },
      },
    },
  },
  "/api/v1/agents/{agentId}/credentials": {
    get: {
      operationId: "listAgentCredentials",
      security: humanSecurity,
      parameters: [workspaceHeader, agentIdParameter],
      responses: {
        "200": jsonResponse("Agent credential metadata without secret hashes", {
          type: "array",
          items: { $ref: "#/components/schemas/AgentCredential" },
        }),
      },
    },
    post: {
      operationId: "issueAgentCredential",
      security: humanSecurity,
      parameters: [workspaceHeader, agentIdParameter],
      responses: {
        "201": jsonResponse("One-time Agent credential", {
          $ref: "#/components/schemas/IssuedAgentCredential",
        }),
      },
    },
  },
  "/api/v1/agents/{agentId}/grant": {
    put: {
      operationId: "setAgentGrant",
      security: humanSecurity,
      parameters: [workspaceHeader, agentIdParameter],
      requestBody: requestBody({
        type: "object",
        additionalProperties: false,
        required: ["permission"],
        properties: { permission: { type: "string", enum: ["read", "write"] } },
      }),
      responses: {
        "200": jsonResponse("Active Agent Workspace grant", {
          $ref: "#/components/schemas/AgentWorkspaceGrant",
        }),
      },
    },
    delete: {
      operationId: "revokeAgentGrant",
      security: humanSecurity,
      parameters: [workspaceHeader, agentIdParameter],
      responses: { "204": { description: "Grant revoked" } },
    },
  },
  "/api/v1/agent-credentials/{credentialId}": {
    delete: {
      operationId: "revokeAgentCredential",
      security: humanSecurity,
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
};

export const agentsSchemas = {
  WorkspaceAgent: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "ownerUserId",
      "name",
      "status",
      "permission",
      "grantStatus",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      ownerUserId: { type: "string", format: "uuid" },
      name: { type: "string" },
      status: { type: "string", enum: ["active", "disabled"] },
      permission: { type: "string", enum: ["read", "write"] },
      grantStatus: { type: "string", enum: ["active", "revoked"] },
      ...timestampProperties,
    },
  },
  UpdateAgentInput: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120 },
      status: { type: "string", enum: ["active", "disabled"] },
    },
  },
  AgentWorkspaceGrant: {
    type: "object",
    additionalProperties: false,
    required: ["workspaceId", "agentId", "permission", "status", "createdAt", "updatedAt"],
    properties: {
      workspaceId: { type: "string", format: "uuid" },
      agentId: { type: "string", format: "uuid" },
      permission: { type: "string", enum: ["read", "write"] },
      status: { type: "string", enum: ["active", "revoked"] },
      ...timestampProperties,
    },
  },
  AgentCredential: {
    type: "object",
    additionalProperties: false,
    required: ["id", "agentId", "prefix", "createdAt", "lastUsedAt", "revokedAt"],
    properties: {
      id: { type: "string", format: "uuid" },
      agentId: { type: "string", format: "uuid" },
      prefix: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      lastUsedAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
      revokedAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    },
  },
  IssuedAgentCredential: {
    type: "object",
    additionalProperties: false,
    required: ["id", "prefix", "token"],
    properties: {
      id: { type: "string", format: "uuid" },
      prefix: { type: "string" },
      token: { type: "string", readOnly: true },
    },
  },
};
