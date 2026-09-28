import {
  MEMORY_GRAPH_LIMITS,
  MEMORY_LINK_DIRECTIONS,
  MEMORY_LINK_LIMITS,
} from "@corespeed/lore-core";
import { CURSOR_MAXIMUM_LENGTH } from "@/server/api/input";
import {
  jsonResponse,
  linkMetadataSchema,
  memoryIdParameter,
  requestBody,
  timestampProperties,
  workspaceHeader,
} from "@/server/openapi/shared";

const memoryLinkParameters = [
  workspaceHeader,
  memoryIdParameter,
  {
    name: "targetMemoryId",
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  },
  {
    name: "kind",
    in: "query",
    description:
      "The Link kind, part of its natural key (source, target, kind). Stored exactly as given: not blank, at most maxLength UTF-16 code units. The query is form-encoded, so a literal + must be sent as %2B. No other query parameter is accepted, and kind may be given once.",
    schema: {
      type: "string",
      minLength: 1,
      maxLength: MEMORY_LINK_LIMITS.maximumKindLength,
      default: MEMORY_LINK_LIMITS.defaultKind,
    },
  },
];

const linkWeightSchema = {
  type: "number",
  minimum: MEMORY_LINK_LIMITS.minimumWeight,
  maximum: MEMORY_LINK_LIMITS.maximumWeight,
} as const;

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
  "/api/v1/memories/{memoryId}/links": {
    get: {
      operationId: "listMemoryLinks",
      description:
        "One page of the Links from (outbound) or to (inbound) a Memory, newest first, with their metadata. Only Links whose two endpoints the Actor can read are listed; a Memory it cannot read is a 404.",
      parameters: [
        workspaceHeader,
        memoryIdParameter,
        {
          name: "direction",
          in: "query",
          schema: {
            type: "string",
            enum: [...MEMORY_LINK_DIRECTIONS],
            default: MEMORY_LINK_DIRECTIONS[0],
          },
        },
        {
          name: "limit",
          in: "query",
          schema: {
            type: "integer",
            minimum: 1,
            maximum: MEMORY_LINK_LIMITS.maximumListLimit,
            default: MEMORY_LINK_LIMITS.defaultListLimit,
          },
        },
        {
          name: "cursor",
          in: "query",
          description: "Opaque cursor from the previous page's x-lore-next-cursor.",
          schema: { type: "string", maxLength: CURSOR_MAXIMUM_LENGTH },
        },
      ],
      responses: {
        "200": jsonResponse(
          "The Memory's visible Links, newest first",
          { type: "array", items: { $ref: "#/components/schemas/MemoryLink" } },
          {
            "x-lore-next-cursor": {
              description: "Present on a full page; opaque to clients.",
              schema: { type: "string" },
            },
          },
        ),
        "400": { $ref: "#/components/responses/Error" },
        "404": { $ref: "#/components/responses/Error" },
      },
    },
  },
  "/api/v1/memories/{memoryId}/links/{targetMemoryId}": {
    put: {
      operationId: "putMemoryLink",
      description: `Create the Link with this natural key, or replace an existing one's weight and metadata; repeating it is safe. The source must be writable and the target visible to the Actor; a missing, invisible, or unwritable endpoint is one 404. Creating a Link past ${MEMORY_LINK_LIMITS.maximumKindsPerPair} kinds from one Memory to another, ${MEMORY_LINK_LIMITS.maximumLinksPerSource} Links from one source, or, counting only Links from the Actor's User's own Memories, ${MEMORY_LINK_LIMITS.maximumLinksPerTarget} Links to one target or ${MEMORY_LINK_LIMITS.maximumLinksPerOwner} in the Workspace, is a 409 memory_link_capacity_exceeded; replacing an existing Link never is. Counts include only Links the Actor can see. Link metadata is limited to ${MEMORY_LINK_LIMITS.maximumMetadataSerializedLength} serialized characters.`,
      parameters: memoryLinkParameters,
      requestBody: requestBody({ $ref: "#/components/schemas/PutMemoryLinkInput" }),
      responses: {
        "200": jsonResponse("Existing Memory Link, replaced or unchanged", {
          $ref: "#/components/schemas/MemoryLink",
        }),
        "201": jsonResponse("Created Memory Link", { $ref: "#/components/schemas/MemoryLink" }),
        "400": { $ref: "#/components/responses/Error" },
        "404": { $ref: "#/components/responses/Error" },
        "409": { $ref: "#/components/responses/Error" },
      },
    },
    delete: {
      operationId: "deleteMemoryLink",
      description:
        "Delete the Link with this natural key. A Link that does not exist, or whose source this Actor may not write or target it cannot see, is one 404.",
      parameters: memoryLinkParameters,
      responses: {
        "204": { description: "Deleted" },
        "400": { $ref: "#/components/responses/Error" },
        "404": { $ref: "#/components/responses/Error" },
      },
    },
  },
};

export const graphSchemas = {
  MemoryLink: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "workspaceId",
      "sourceMemoryId",
      "targetMemoryId",
      "kind",
      "weight",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      workspaceId: { type: "string", format: "uuid" },
      sourceMemoryId: { type: "string", format: "uuid" },
      targetMemoryId: { type: "string", format: "uuid" },
      kind: { type: "string", minLength: 1, maxLength: MEMORY_LINK_LIMITS.maximumKindLength },
      weight: linkWeightSchema,
      metadata: linkMetadataSchema,
      ...timestampProperties,
    },
  },
  PutMemoryLinkInput: {
    type: "object",
    additionalProperties: false,
    description: "Omitted fields take their defaults, as a PUT replaces the whole Link.",
    properties: {
      weight: { ...linkWeightSchema, default: MEMORY_LINK_LIMITS.defaultWeight },
      metadata: { ...linkMetadataSchema, default: {} },
    },
  },
};
