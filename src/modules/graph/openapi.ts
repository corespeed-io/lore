import { MEMORY_GRAPH_LIMITS } from "@corespeed/lore-core";
import { jsonResponse, workspaceHeader } from "@/server/openapi/shared";

export const graphPaths = {
  "/api/v1/graph": {
    get: {
      operationId: "getMemoryGraph",
      parameters: [
        workspaceHeader,
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: MEMORY_GRAPH_LIMITS.maximumNodes },
        },
      ],
      responses: {
        "200": jsonResponse("Actor-visible graph with authorized endpoints", {
          $ref: "#/components/schemas/MemoryGraph",
        }),
        "400": { $ref: "#/components/responses/Error" },
      },
    },
  },
};
