import {
  humanSecurity,
  jsonResponse,
  requestBody,
  timestampProperties,
  workspaceHeader,
} from "@/server/openapi/shared";

export const workspacesPaths = {
  "/api/v1/actor": {
    get: {
      operationId: "getCurrentHumanActor",
      security: humanSecurity,
      parameters: [workspaceHeader],
      responses: {
        "200": jsonResponse("Verified human Actor for the active Workspace", {
          $ref: "#/components/schemas/HumanActor",
        }),
      },
    },
  },
  "/api/v1/workspaces": {
    get: {
      operationId: "listWorkspaces",
      security: humanSecurity,
      responses: {
        "200": jsonResponse("Workspaces available to the authenticated User", {
          type: "array",
          items: { $ref: "#/components/schemas/WorkspaceSummary" },
        }),
      },
    },
    post: {
      operationId: "createWorkspace",
      security: humanSecurity,
      requestBody: requestBody({
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string", minLength: 1, maxLength: 120 } },
      }),
      responses: {
        "201": jsonResponse("Created Workspace", {
          $ref: "#/components/schemas/Workspace",
        }),
      },
    },
  },
};

export const workspacesSchemas = {
  HumanActor: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "userId"],
    properties: {
      kind: { const: "human" },
      userId: { type: "string", format: "uuid" },
    },
  },
  Workspace: {
    type: "object",
    additionalProperties: false,
    required: ["id", "name", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      ...timestampProperties,
    },
  },
  WorkspaceSummary: {
    type: "object",
    additionalProperties: false,
    required: ["id", "name", "role", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      role: { type: "string", enum: ["owner", "admin", "member"] },
      ...timestampProperties,
    },
  },
};
