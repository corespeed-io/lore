import { humanSecurity, jsonResponse, workspaceHeader } from "@/server/openapi/shared";

export const identityPaths = {
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
};

export const identitySchemas = {
  HumanActor: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "userId"],
    properties: {
      kind: { const: "human" },
      userId: { type: "string", format: "uuid" },
    },
  },
};
