import {
  humanSecurity,
  jsonResponse,
  requestBody,
  timestampProperties,
  workspaceHeader,
} from "@/server/openapi/shared";

export const evaluationsPaths = {
  "/api/v1/evaluations/suites": {
    get: {
      operationId: "listEvaluationSuites",
      security: humanSecurity,
      parameters: [
        workspaceHeader,
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
        {
          name: "cursor",
          in: "query",
          description: "Opaque x-lore-next-cursor value from the previous page.",
          schema: { type: "string", maxLength: 512 },
        },
      ],
      responses: {
        "200": jsonResponse(
          "One page of this User's Workspace Evaluation Suites, newest first",
          {
            type: "array",
            items: { $ref: "#/components/schemas/EvaluationSuite" },
          },
          {
            "x-lore-next-cursor": {
              description: "Present when more Suites follow; opaque to clients.",
              schema: { type: "string" },
            },
          },
        ),
      },
    },
    post: {
      operationId: "createEvaluationSuite",
      security: humanSecurity,
      parameters: [workspaceHeader],
      requestBody: requestBody({ $ref: "#/components/schemas/CreateEvaluationSuiteInput" }),
      responses: {
        "201": jsonResponse("Created Evaluation Suite", {
          $ref: "#/components/schemas/EvaluationSuite",
        }),
      },
    },
  },
  "/api/v1/evaluations/suites/{suiteId}/runs": {
    post: {
      operationId: "runEvaluationSuite",
      security: humanSecurity,
      parameters: [
        workspaceHeader,
        {
          name: "suiteId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "201": jsonResponse("Completed Evaluation Run", {
          $ref: "#/components/schemas/EvaluationRun",
        }),
      },
    },
  },
  "/api/v1/evaluations/runs/{runId}": {
    get: {
      operationId: "getEvaluationRun",
      security: humanSecurity,
      parameters: [
        workspaceHeader,
        {
          name: "runId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": jsonResponse("Evaluation Run and results", {
          $ref: "#/components/schemas/EvaluationRun",
        }),
      },
    },
  },
};

export const evaluationsSchemas = {
  EvaluationCaseInput: {
    type: "object",
    additionalProperties: false,
    required: ["query", "expectedMemoryIds"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: 10_000 },
      expectedMemoryIds: {
        type: "array",
        minItems: 1,
        items: { type: "string", format: "uuid" },
      },
      forbiddenMemoryIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
      },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
  CreateEvaluationSuiteInput: {
    type: "object",
    additionalProperties: false,
    required: ["name", "cases"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120 },
      version: { type: "integer", minimum: 1, default: 1 },
      description: { type: "string", maxLength: 10_000 },
      cases: {
        type: "array",
        minItems: 1,
        maxItems: 1_000,
        items: { $ref: "#/components/schemas/EvaluationCaseInput" },
      },
    },
  },
  EvaluationCase: {
    type: "object",
    additionalProperties: false,
    required: ["id", "ordinal", "query", "expectedMemoryIds", "forbiddenMemoryIds", "limit"],
    properties: {
      id: { type: "string", format: "uuid" },
      ordinal: { type: "integer", minimum: 0 },
      query: { type: "string" },
      expectedMemoryIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
      },
      forbiddenMemoryIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
      },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
  EvaluationSuite: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "workspaceId",
      "createdByUserId",
      "name",
      "version",
      "description",
      "cases",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      workspaceId: { type: "string", format: "uuid" },
      createdByUserId: { type: "string", format: "uuid" },
      name: { type: "string" },
      version: { type: "integer", minimum: 1 },
      description: { type: "string" },
      cases: { type: "array", items: { $ref: "#/components/schemas/EvaluationCase" } },
      ...timestampProperties,
    },
  },
  EvaluationRunMetrics: {
    type: "object",
    additionalProperties: false,
    required: [
      "recallAtK",
      "reciprocalRank",
      "ndcgAtK",
      "isolationPassed",
      "hardFailureCount",
      "caseCount",
      "averageLatencyMs",
      "estimatedCostUsd",
    ],
    properties: {
      recallAtK: { type: "number" },
      reciprocalRank: { type: "number" },
      ndcgAtK: { type: "number" },
      isolationPassed: { type: "boolean" },
      hardFailureCount: { type: "integer", minimum: 0 },
      caseCount: { type: "integer", minimum: 0 },
      averageLatencyMs: { type: "number", minimum: 0 },
      estimatedCostUsd: { type: "number", minimum: 0 },
    },
  },
  EvaluationResult: {
    type: "object",
    additionalProperties: false,
    required: ["id", "caseId", "retrievedMemoryIds", "metrics", "latencyMs", "estimatedCostUsd"],
    properties: {
      id: { type: "string", format: "uuid" },
      caseId: { type: "string", format: "uuid" },
      retrievedMemoryIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
      },
      metrics: { $ref: "#/components/schemas/RankingMetrics" },
      latencyMs: { type: "number", minimum: 0 },
      estimatedCostUsd: { type: "number", minimum: 0 },
    },
  },
  EvaluationRun: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "suiteId",
      "workspaceId",
      "status",
      "metrics",
      "error",
      "results",
      "startedAt",
      "completedAt",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      suiteId: { type: "string", format: "uuid" },
      workspaceId: { type: "string", format: "uuid" },
      status: { type: "string", enum: ["running", "completed", "failed"] },
      metrics: { $ref: "#/components/schemas/EvaluationRunMetrics" },
      error: { oneOf: [{ type: "string" }, { type: "null" }] },
      results: { type: "array", items: { $ref: "#/components/schemas/EvaluationResult" } },
      startedAt: { type: "string", format: "date-time" },
      completedAt: {
        oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
      },
    },
  },
};
