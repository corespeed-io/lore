import {
  idempotencyHeader,
  ifMatchHeader,
  jsonResponse,
  memoryIdParameter,
  requestBody,
  workspaceHeader,
} from "@/server/openapi/shared";
import { memoryOpenApiSchemas } from "./schemas";

const memorySchemas = memoryOpenApiSchemas();

export const memoriesPaths = {
  "/api/v1/memories": {
    get: {
      operationId: "listOrSearchMemories",
      parameters: [
        workspaceHeader,
        { name: "q", in: "query", schema: { type: "string", maxLength: 10_000 } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
        {
          name: "offset",
          in: "query",
          schema: { type: "integer", minimum: 0, maximum: 1_000_000 },
        },
        {
          name: "cursor",
          in: "query",
          description: "Opaque browse cursor; mutually exclusive with offset.",
          schema: { type: "string" },
        },
        {
          name: "scope",
          in: "query",
          schema: { type: "string", enum: ["shared", "private"] },
        },
        {
          name: "updated_after",
          in: "query",
          description: "Inclusive lower bound for Memory updated_at.",
          schema: { type: "string", format: "date-time" },
        },
        {
          name: "updated_before",
          in: "query",
          description: "Exclusive upper bound for Memory updated_at.",
          schema: { type: "string", format: "date-time" },
        },
        {
          name: "metadata",
          in: "query",
          description: "JSON object applied as a bounded JSONB-containment filter.",
          schema: { type: "string", maxLength: 10_000 },
        },
      ],
      responses: {
        "200": jsonResponse(
          "Actor-visible Memories, or ranked results when q is present.",
          {
            anyOf: [
              { type: "array", items: { $ref: "#/components/schemas/Memory" } },
              { type: "array", items: { $ref: "#/components/schemas/MemorySearchResult" } },
            ],
          },
          {
            "x-lore-next-cursor": {
              description: "Present on a full browse page; opaque to clients.",
              schema: { type: "string" },
            },
          },
        ),
      },
    },
    post: {
      operationId: "createMemory",
      parameters: [workspaceHeader, idempotencyHeader],
      requestBody: requestBody({ $ref: "#/components/schemas/CreateMemoryInput" }),
      responses: {
        "201": jsonResponse(
          "Created Memory",
          { $ref: "#/components/schemas/Memory" },
          { ETag: { schema: { type: "string" } } },
        ),
        "409": { $ref: "#/components/responses/Error" },
      },
    },
  },
  "/api/v1/memories/{memoryId}": {
    get: {
      operationId: "getMemory",
      parameters: [workspaceHeader, memoryIdParameter],
      responses: {
        "200": jsonResponse(
          "Memory with a strong ETag",
          { $ref: "#/components/schemas/Memory" },
          { ETag: { schema: { type: "string" } } },
        ),
        "404": { $ref: "#/components/responses/Error" },
      },
    },
    patch: {
      operationId: "updateMemory",
      parameters: [workspaceHeader, idempotencyHeader, ifMatchHeader, memoryIdParameter],
      requestBody: requestBody({ $ref: "#/components/schemas/UpdateMemoryInput" }),
      responses: {
        "200": jsonResponse(
          "Updated Memory",
          { $ref: "#/components/schemas/Memory" },
          { ETag: { schema: { type: "string" } } },
        ),
        "412": { $ref: "#/components/responses/Error" },
        "428": { $ref: "#/components/responses/Error" },
      },
    },
    delete: {
      operationId: "deleteMemory",
      parameters: [workspaceHeader, idempotencyHeader, ifMatchHeader, memoryIdParameter],
      responses: {
        "204": { description: "Deleted" },
        "412": { $ref: "#/components/responses/Error" },
        "428": { $ref: "#/components/responses/Error" },
      },
    },
  },
};

export const memoriesSchemas = {
  ...memorySchemas,
  MemorySearchResult: {
    type: "object",
    additionalProperties: false,
    required: ["memory", "score", "evidence"],
    properties: {
      memory: { $ref: "#/components/schemas/Memory" },
      score: { type: "number" },
      rerankScore: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Present only after a successful calibrated reranker call.",
      },
      evidence: { type: "string" },
    },
  },
  MemoryGraph: {
    type: "object",
    additionalProperties: false,
    required: ["nodes", "links"],
    properties: {
      nodes: { type: "array", items: { $ref: "#/components/schemas/MemoryGraphNode" } },
      links: { type: "array", items: { $ref: "#/components/schemas/MemoryGraphLink" } },
    },
  },
  MemoryGraphNode: {
    type: "object",
    additionalProperties: false,
    required: ["id", "reference", "label", "preview", "scope", "type", "updatedAt"],
    properties: {
      id: { type: "string", format: "uuid" },
      reference: { type: "string" },
      label: { type: "string" },
      preview: { type: "string" },
      scope: { type: "string", enum: ["shared", "private"] },
      type: { type: "string" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  MemoryGraphLink: {
    type: "object",
    additionalProperties: false,
    required: ["source", "target", "kind", "weight"],
    properties: {
      source: { type: "string", format: "uuid" },
      target: { type: "string", format: "uuid" },
      kind: { type: "string" },
      weight: { type: "number", minimum: 0, maximum: 1 },
    },
  },
};
