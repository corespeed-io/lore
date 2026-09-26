import { actorSecurity, errorSchema, jsonResponse, workspaceHeader } from "@/server/openapi/shared";
import { DEPLOYMENT_LIMITS, MEMORY_CHUNKING_CAPABILITY } from "./limits";

/** One `{ const }` schema per published value, in declaration order. */
function constProperties(
  values: Readonly<Record<string, number | string>>,
): Record<string, { const: number | string }> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, { const: value }]),
  );
}

export const operationsPaths = {
  "/api/v1/capabilities": {
    get: {
      operationId: "getCapabilities",
      security: actorSecurity,
      parameters: [workspaceHeader],
      responses: {
        "200": jsonResponse("Deployment capabilities without tenant data", {
          $ref: "#/components/schemas/Capabilities",
        }),
      },
    },
  },
  "/livez": {
    get: {
      operationId: "getLiveness",
      security: [],
      responses: {
        "200": jsonResponse("Process is live", {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: { status: { const: "live" } },
        }),
      },
    },
  },
  "/readyz": {
    get: {
      operationId: "getReadiness",
      security: [],
      responses: {
        "200": jsonResponse("Ready or degraded", {
          $ref: "#/components/schemas/ReadinessReport",
        }),
        "503": jsonResponse("Not ready", {
          $ref: "#/components/schemas/ReadinessReport",
        }),
      },
    },
  },
};

export const operationsSchemas = {
  Error: errorSchema,
  RankingMetrics: {
    type: "object",
    additionalProperties: false,
    required: [
      "recallAtK",
      "reciprocalRank",
      "ndcgAtK",
      "isolationPassed",
      "forbiddenRetrievedIds",
    ],
    properties: {
      recallAtK: { type: "number" },
      reciprocalRank: { type: "number" },
      ndcgAtK: { type: "number" },
      isolationPassed: { type: "boolean" },
      forbiddenRetrievedIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
      },
    },
  },
  Capabilities: {
    type: "object",
    additionalProperties: false,
    required: [
      "apiVersion",
      "schemaRevision",
      "deploymentId",
      "memoryChunking",
      "features",
      "limits",
      "activeEmbeddingGeneration",
    ],
    properties: {
      apiVersion: { const: "v1" },
      schemaRevision: { type: "integer", minimum: 1 },
      deploymentId: { type: "string", format: "uuid" },
      memoryChunking: {
        type: "object",
        additionalProperties: false,
        required: ["revision", "maximumCharacters", "overlapCharacters"],
        properties: constProperties(MEMORY_CHUNKING_CAPABILITY),
      },
      features: {
        type: "object",
        additionalProperties: false,
        required: [
          "idempotency",
          "optimisticConcurrency",
          "transactionalOutbox",
          "workspacePortability",
          "embeddingGenerations",
          "cursorPagination",
          "memoryProposals",
          "observationEvidence",
          "codeIndex",
          "codeDependencies",
          "codeEvidence",
        ],
        properties: {
          idempotency: { const: true },
          optimisticConcurrency: { const: true },
          transactionalOutbox: { const: true },
          workspacePortability: { const: true },
          embeddingGenerations: { const: true },
          cursorPagination: { const: true },
          memoryProposals: { const: true },
          observationEvidence: { const: true },
          codeIndex: { const: true },
          codeDependencies: { const: true },
          codeEvidence: { const: true },
        },
      },
      limits: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(DEPLOYMENT_LIMITS),
        properties: constProperties(DEPLOYMENT_LIMITS),
      },
      activeEmbeddingGeneration: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["provider", "model", "dimensions", "revision"],
            properties: {
              provider: { type: "string" },
              model: { type: "string" },
              dimensions: { const: 1024 },
              revision: { type: "string" },
            },
          },
          { type: "null" },
        ],
      },
    },
  },
  ReadinessReport: {
    type: "object",
    additionalProperties: false,
    required: ["status", "components"],
    properties: {
      status: { type: "string", enum: ["ready", "degraded", "unready"] },
      components: {
        type: "object",
        additionalProperties: false,
        required: ["database", "embedding", "rlsRole", "schema", "vector"],
        properties: {
          database: { type: "string", enum: ["ok", "unavailable"] },
          embedding: {
            type: "string",
            enum: ["ok", "degraded", "disabled", "unknown"],
          },
          rlsRole: { type: "string", enum: ["ok", "unavailable"] },
          schema: { type: "string", enum: ["ok", "incompatible", "unavailable"] },
          vector: { type: "string", enum: ["ok", "unavailable"] },
        },
      },
    },
  },
};
