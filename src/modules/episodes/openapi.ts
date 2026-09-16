import {
  idempotencyHeader,
  jsonResponse,
  requestBody,
  workspaceHeader,
} from "@/server/openapi/shared";

const episodeSummaryProperties = {
  id: { type: "string", format: "uuid" },
  workspaceId: { type: "string", format: "uuid" },
  ownerUserId: { type: "string", format: "uuid" },
  recordedByActorKind: { type: "string", enum: ["human", "agent"] },
  recordedByAgentId: {
    oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
  },
  kind: { type: "string", enum: ["conversation", "workflow", "document", "event"] },
  scope: { type: "string", enum: ["shared", "private"] },
  startedAt: { type: "string", format: "date-time" },
  endedAt: { type: "string", format: "date-time" },
  observationCount: { type: "integer", minimum: 1, maximum: 100 },
  createdAt: { type: "string", format: "date-time" },
} as const;

const episodeSummaryRequired = [
  "id",
  "workspaceId",
  "ownerUserId",
  "recordedByActorKind",
  "recordedByAgentId",
  "kind",
  "scope",
  "startedAt",
  "endedAt",
  "observationCount",
  "createdAt",
] as const;

export const episodesPaths = {
  "/api/v1/episodes": {
    get: {
      operationId: "listEpisodes",
      parameters: [
        workspaceHeader,
        {
          name: "kind",
          in: "query",
          schema: {
            type: "string",
            enum: ["conversation", "workflow", "document", "event"],
          },
        },
        {
          name: "scope",
          in: "query",
          schema: { type: "string", enum: ["shared", "private"] },
        },
        {
          name: "cursor",
          in: "query",
          description: "Opaque Episode browse cursor.",
          schema: { type: "string" },
        },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
      ],
      responses: {
        "200": jsonResponse(
          "Actor-visible immutable Episode envelopes",
          {
            type: "array",
            items: { $ref: "#/components/schemas/EpisodeSummary" },
          },
          {
            "x-lore-next-cursor": {
              description: "Present on a full page; opaque to clients.",
              schema: { type: "string" },
            },
          },
        ),
      },
    },
    post: {
      operationId: "recordEpisode",
      parameters: [workspaceHeader, idempotencyHeader],
      requestBody: requestBody({ $ref: "#/components/schemas/RecordEpisodeInput" }),
      responses: {
        "201": jsonResponse("Recorded immutable Episode evidence", {
          $ref: "#/components/schemas/Episode",
        }),
        "403": { $ref: "#/components/responses/Error" },
        "409": { $ref: "#/components/responses/Error" },
      },
    },
  },
  "/api/v1/episodes/{episodeId}": {
    get: {
      operationId: "getEpisode",
      parameters: [
        workspaceHeader,
        {
          name: "episodeId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": jsonResponse("Episode with available Observation payloads", {
          $ref: "#/components/schemas/Episode",
        }),
        "404": { $ref: "#/components/responses/Error" },
      },
    },
    delete: {
      operationId: "deleteEpisode",
      parameters: [
        workspaceHeader,
        idempotencyHeader,
        {
          name: "episodeId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "204": { description: "Deleted Episode and Observation evidence" },
        "404": { $ref: "#/components/responses/Error" },
      },
    },
  },
  "/api/v1/observations": {
    get: {
      operationId: "getObservations",
      parameters: [
        workspaceHeader,
        {
          name: "id",
          in: "query",
          required: true,
          description: "Repeat for 1 to 50 RLS-visible Observation ids.",
          schema: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: { type: "string", format: "uuid" },
          },
          style: "form",
          explode: true,
        },
      ],
      responses: {
        "200": jsonResponse("Visible immutable Observation evidence in request order", {
          type: "array",
          items: { $ref: "#/components/schemas/Observation" },
        }),
      },
    },
  },
};

export const episodesSchemas = {
  RecordObservationInput: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "content"],
    properties: {
      kind: {
        type: "string",
        enum: ["message", "tool_call", "tool_result", "document_fragment", "event"],
      },
      content: { type: "string", minLength: 1, maxLength: 100_000 },
      metadata: { type: "object", additionalProperties: true },
      observedAt: { type: "string", format: "date-time" },
    },
  },
  RecordEpisodeInput: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "observations"],
    properties: {
      kind: {
        type: "string",
        enum: ["conversation", "workflow", "document", "event"],
      },
      scope: { type: "string", enum: ["shared", "private"], default: "private" },
      observations: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { $ref: "#/components/schemas/RecordObservationInput" },
      },
    },
  },
  Observation: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "workspaceId",
      "episodeId",
      "ordinal",
      "kind",
      "observedAt",
      "payloadSha256",
      "content",
      "metadata",
      "createdAt",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      workspaceId: { type: "string", format: "uuid" },
      episodeId: { type: "string", format: "uuid" },
      ordinal: { type: "integer", minimum: 0, maximum: 99 },
      kind: {
        type: "string",
        enum: ["message", "tool_call", "tool_result", "document_fragment", "event"],
      },
      observedAt: { type: "string", format: "date-time" },
      payloadSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      content: { type: "string", minLength: 1, maxLength: 100_000 },
      metadata: { type: "object", additionalProperties: true },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  EpisodeSummary: {
    type: "object",
    additionalProperties: false,
    required: episodeSummaryRequired,
    properties: episodeSummaryProperties,
  },
  Episode: {
    type: "object",
    additionalProperties: false,
    required: [...episodeSummaryRequired, "observations"],
    properties: {
      ...episodeSummaryProperties,
      observations: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { $ref: "#/components/schemas/Observation" },
      },
    },
  },
};
