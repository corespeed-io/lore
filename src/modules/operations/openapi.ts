import {
  MEMORY_CHUNK_MAXIMUM_CHARACTERS,
  MEMORY_CHUNK_OVERLAP_CHARACTERS,
  MEMORY_CHUNKING_REVISION,
  MEMORY_CONTENT_LIMITS,
} from "@corespeed/lore-core";
import {
  MAX_WORKSPACE_ARCHIVE_LINKS,
  MAX_WORKSPACE_ARCHIVE_MEMORIES,
} from "@/modules/portability/service";
import { actorSecurity, errorSchema, jsonResponse, workspaceHeader } from "@/server/openapi/shared";

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
        properties: {
          revision: { const: MEMORY_CHUNKING_REVISION },
          maximumCharacters: { const: MEMORY_CHUNK_MAXIMUM_CHARACTERS },
          overlapCharacters: { const: MEMORY_CHUNK_OVERLAP_CHARACTERS },
        },
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
        required: [
          "memoryContentRecommendedCharacters",
          "memoryContentMaximumCharacters",
          "memoryMaximumChunks",
          "workspaceArchiveMemories",
          "workspaceArchiveLinks",
          "memoryProposalEvidence",
          "memoryProposalList",
          "memoryProposalPending",
          "memoryProposalRetentionSeconds",
          "episodeObservations",
          "episodeContentCharacters",
          "episodeMetadataCharacters",
          "observationContentCharacters",
          "observationBatchRead",
          "codeIndexFiles",
          "codeIndexSourceBytes",
          "codeIndexArtifacts",
          "codeDependencyResults",
          "codeSearchResults",
        ],
        properties: {
          memoryContentRecommendedCharacters: {
            const: MEMORY_CONTENT_LIMITS.recommendedCharacters,
          },
          memoryContentMaximumCharacters: {
            const: MEMORY_CONTENT_LIMITS.maximumCharacters,
          },
          memoryMaximumChunks: { const: MEMORY_CONTENT_LIMITS.maximumChunks },
          workspaceArchiveMemories: { const: MAX_WORKSPACE_ARCHIVE_MEMORIES },
          workspaceArchiveLinks: { const: MAX_WORKSPACE_ARCHIVE_LINKS },
          memoryProposalEvidence: { const: 50 },
          memoryProposalList: { const: 100 },
          memoryProposalPending: { const: 100 },
          memoryProposalRetentionSeconds: { const: 2_592_000 },
          episodeObservations: { const: 100 },
          episodeContentCharacters: { const: 1_000_000 },
          episodeMetadataCharacters: { const: 1_000_000 },
          observationContentCharacters: { const: 100_000 },
          observationBatchRead: { const: 50 },
          codeIndexFiles: { const: 20_000 },
          codeIndexSourceBytes: { const: 134_217_728 },
          codeIndexArtifacts: { const: 100_000 },
          codeDependencyResults: { const: 200 },
          codeSearchResults: { const: 100 },
        },
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
