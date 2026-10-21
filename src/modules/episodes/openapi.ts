import { MEMORY_LIST_LIMITS, MEMORY_SEARCH_LIMITS } from "@corespeed/lore-core";
import {
  EPISODE_EVIDENCE_INDEX_REVISION,
  EPISODE_KINDS,
  MAX_EPISODE_OBSERVATIONS,
  MAX_OBSERVATION_BATCH_READ,
  MAX_OBSERVATION_CONTENT_CHARACTERS,
  OBSERVATION_KINDS,
} from "@corespeed/lore-core/episodes";
import { MEMORY_OBSERVATION_EVIDENCE_LIMITS } from "@/modules/episodes/observation-evidence";
import { CURSOR_MAXIMUM_LENGTH } from "@/server/api/input";
import {
  idempotencyHeader,
  jsonResponse,
  memoryIdParameter,
  memoryScopeSchema,
  metadataSchema,
  requestBody,
  SEARCH_TRANSLATIONS_DESCRIPTION,
  searchTranslationsSchema,
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
  kind: { type: "string", enum: [...EPISODE_KINDS] },
  scope: memoryScopeSchema,
  startedAt: { type: "string", format: "date-time" },
  endedAt: { type: "string", format: "date-time" },
  observationCount: { type: "integer", minimum: 1, maximum: MAX_EPISODE_OBSERVATIONS },
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

const recordingPaths = {
  "/api/v1/episodes/search": {
    post: {
      operationId: "searchEpisodeEvidence",
      description:
        "Read-only lexical retrieval of original Observation excerpts. Does not search or create canonical Memory. Filters apply before ranking; timestamps are source chronology, not a guarantee that the newest claim is true.",
      parameters: [workspaceHeader],
      requestBody: requestBody({ $ref: "#/components/schemas/SearchEpisodeEvidenceInput" }),
      responses: {
        "200": jsonResponse("Actor-visible raw evidence with exact chunk locators", {
          type: "array",
          items: { $ref: "#/components/schemas/EpisodeEvidenceSearchResult" },
        }),
      },
    },
  },
  "/api/v1/episodes/{episodeId}/index": {
    post: {
      operationId: "indexEpisodeEvidence",
      description:
        "Idempotently build exact lexical source chunks for an owned Episode. Recording does not index, and search never indexes. No model calls.",
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
        "200": jsonResponse("Lexical evidence index", {
          $ref: "#/components/schemas/EpisodeEvidenceIndex",
        }),
        "403": { $ref: "#/components/responses/Error" },
      },
    },
  },
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
            enum: [...EPISODE_KINDS],
          },
        },
        {
          name: "scope",
          in: "query",
          schema: memoryScopeSchema,
        },
        {
          name: "cursor",
          in: "query",
          description: "Opaque Episode browse cursor.",
          schema: { type: "string", maxLength: CURSOR_MAXIMUM_LENGTH },
        },
        {
          name: "limit",
          in: "query",
          schema: {
            type: "integer",
            minimum: 1,
            maximum: MEMORY_LIST_LIMITS.maximumLimit,
            default: MEMORY_LIST_LIMITS.defaultLimit,
          },
        },
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
          description: `Repeat for 1 to ${MAX_OBSERVATION_BATCH_READ} RLS-visible Observation ids.`,
          schema: {
            type: "array",
            minItems: 1,
            maxItems: MAX_OBSERVATION_BATCH_READ,
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

const recordingSchemas = {
  SearchEpisodeEvidenceInput: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", maxLength: MEMORY_SEARCH_LIMITS.maximumQueryLength },
      translations: { ...searchTranslationsSchema, description: SEARCH_TRANSLATIONS_DESCRIPTION },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MEMORY_SEARCH_LIMITS.maximumLimit,
        default: MEMORY_SEARCH_LIMITS.defaultLimit,
      },
      scope: memoryScopeSchema,
      metadata: metadataSchema,
    },
  },
  EpisodeEvidenceIndex: {
    type: "object",
    additionalProperties: false,
    required: ["episodeId", "chunkCount", "indexRevision"],
    properties: {
      episodeId: { type: "string", format: "uuid" },
      chunkCount: { type: "integer", minimum: 1 },
      indexRevision: { type: "string", const: EPISODE_EVIDENCE_INDEX_REVISION },
    },
  },
  EpisodeEvidenceExcerpt: {
    type: "object",
    additionalProperties: false,
    required: [
      "indexRevision",
      "episodeId",
      "observationId",
      "observationOrdinal",
      "observedAt",
      "chunkStartOrdinal",
      "chunkEndOrdinal",
      "content",
      "metadata",
    ],
    properties: {
      indexRevision: { type: "string", const: EPISODE_EVIDENCE_INDEX_REVISION },
      episodeId: { type: "string", format: "uuid" },
      observationId: { type: "string", format: "uuid" },
      observationOrdinal: { type: "integer", minimum: 0, maximum: MAX_EPISODE_OBSERVATIONS - 1 },
      observedAt: { type: "string", format: "date-time" },
      chunkStartOrdinal: { type: "integer", minimum: 0 },
      chunkEndOrdinal: { type: "integer", minimum: 0 },
      content: { type: "string" },
      metadata: metadataSchema,
    },
  },
  EpisodeEvidenceSearchResult: {
    type: "object",
    additionalProperties: false,
    required: [
      "sourceKey",
      "episodeIds",
      "observationIds",
      "metadata",
      "evidence",
      "excerpts",
      "score",
    ],
    properties: {
      sourceKey: { type: "string" },
      episodeIds: { type: "array", items: { type: "string", format: "uuid" } },
      observationIds: { type: "array", items: { type: "string", format: "uuid" } },
      metadata: metadataSchema,
      evidence: { type: "string" },
      excerpts: { type: "array", items: { $ref: "#/components/schemas/EpisodeEvidenceExcerpt" } },
      score: { type: "number" },
      rerankScore: { type: "number" },
    },
  },
  RecordObservationInput: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "content"],
    properties: {
      kind: {
        type: "string",
        enum: [...OBSERVATION_KINDS],
      },
      content: { type: "string", minLength: 1, maxLength: MAX_OBSERVATION_CONTENT_CHARACTERS },
      metadata: metadataSchema,
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
        enum: [...EPISODE_KINDS],
      },
      scope: { ...memoryScopeSchema, default: "private" },
      observations: {
        type: "array",
        minItems: 1,
        maxItems: MAX_EPISODE_OBSERVATIONS,
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
      ordinal: { type: "integer", minimum: 0, maximum: MAX_EPISODE_OBSERVATIONS - 1 },
      kind: {
        type: "string",
        enum: [...OBSERVATION_KINDS],
      },
      observedAt: { type: "string", format: "date-time" },
      payloadSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      content: { type: "string", minLength: 1, maxLength: MAX_OBSERVATION_CONTENT_CHARACTERS },
      metadata: metadataSchema,
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
        maxItems: MAX_EPISODE_OBSERVATIONS,
        items: { $ref: "#/components/schemas/Observation" },
      },
    },
  },
};

const evidenceLimits = MEMORY_OBSERVATION_EVIDENCE_LIMITS;

const observationEvidenceKeyParameters = [
  workspaceHeader,
  memoryIdParameter,
  {
    name: "observationId",
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  },
];

const observationEvidencePaths = {
  "/api/v1/memories/observation-evidence/read": {
    post: {
      operationId: "readMemoryObservationEvidence",
      description: `Read the original Observations the given Memories cite, for an answer the Memories alone could not give. Read-only. Memories are read in the given order, such as search rank, and each one's Observations oldest observed first; an Observation cited by several is returned once with every citing Memory. Whole Observations fill the character budget (code points, default ${evidenceLimits.defaultReadCharacters}); the first one past it is cut to fit and the rest are listed as omitted. A Memory or Observation the Actor cannot see contributes nothing. The content is raw recorded evidence, not canonical Memory.`,
      parameters: [workspaceHeader],
      requestBody: requestBody({ $ref: "#/components/schemas/ReadMemoryObservationEvidenceInput" }),
      responses: {
        "200": jsonResponse("Cited Observations within the budget", {
          $ref: "#/components/schemas/MemorySourceRead",
        }),
        "400": { $ref: "#/components/responses/Error" },
      },
    },
  },
  "/api/v1/memories/{memoryId}/observation-evidence": {
    get: {
      operationId: "listMemoryObservationEvidence",
      description:
        "The Observations a visible Memory cites, oldest observed first. A citation is listed only while its Observation's Episode is visible to the Actor. A missing or invisible Memory is a 404.",
      parameters: [workspaceHeader, memoryIdParameter],
      responses: {
        "200": jsonResponse("The Memory's visible Observation citations", {
          type: "array",
          maxItems: evidenceLimits.maximumObservationsPerMemory,
          items: { $ref: "#/components/schemas/MemoryObservationEvidence" },
        }),
        "400": { $ref: "#/components/responses/Error" },
        "404": { $ref: "#/components/responses/Error" },
      },
    },
  },
  "/api/v1/memories/{memoryId}/observation-evidence/{observationId}": {
    put: {
      operationId: "citeMemoryObservationEvidence",
      description: `Record that the Memory came from this Observation; repeating it is safe. The Memory must be writable and the Observation visible to the Actor; a missing, invisible, or unwritable endpoint is one 404. A Memory cites at most ${evidenceLimits.maximumObservationsPerMemory} Observations, counting only citations the Actor can see; one more is a 409 memory_observation_evidence_capacity_exceeded. Forgetting the Memory or the Observation's Episode removes the citation.`,
      parameters: observationEvidenceKeyParameters,
      responses: {
        "200": jsonResponse("Existing citation, unchanged", {
          $ref: "#/components/schemas/MemoryObservationEvidence",
        }),
        "201": jsonResponse("Created citation", {
          $ref: "#/components/schemas/MemoryObservationEvidence",
        }),
        "400": { $ref: "#/components/responses/Error" },
        "404": { $ref: "#/components/responses/Error" },
        "409": { $ref: "#/components/responses/Error" },
      },
    },
    delete: {
      operationId: "removeMemoryObservationEvidence",
      description:
        "Remove the citation. A citation that does not exist, or whose Memory this Actor may not write or whose Observation it cannot see, is one 404.",
      parameters: observationEvidenceKeyParameters,
      responses: {
        "204": { description: "Removed" },
        "400": { $ref: "#/components/responses/Error" },
        "404": { $ref: "#/components/responses/Error" },
      },
    },
  },
};

const observationEvidenceSchemas = {
  MemoryObservationEvidence: {
    type: "object",
    additionalProperties: false,
    required: [
      "memoryId",
      "observationId",
      "episodeId",
      "observationOrdinal",
      "observationKind",
      "observedAt",
      "createdByUserId",
      "createdByAgentId",
      "createdAt",
    ],
    properties: {
      memoryId: { type: "string", format: "uuid" },
      observationId: { type: "string", format: "uuid" },
      episodeId: { type: "string", format: "uuid" },
      observationOrdinal: { type: "integer", minimum: 0 },
      observationKind: { type: "string", enum: [...OBSERVATION_KINDS] },
      observedAt: { type: "string", format: "date-time" },
      createdByUserId: { type: "string", format: "uuid" },
      createdByAgentId: { oneOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  ReadMemoryObservationEvidenceInput: {
    type: "object",
    additionalProperties: false,
    required: ["memoryIds"],
    properties: {
      memoryIds: {
        type: "array",
        minItems: 1,
        maxItems: evidenceLimits.maximumReadMemories,
        uniqueItems: true,
        items: { type: "string", format: "uuid" },
      },
      maximumCharacters: {
        type: "integer",
        minimum: 1,
        maximum: evidenceLimits.maximumReadCharacters,
        default: evidenceLimits.defaultReadCharacters,
      },
    },
  },
  MemorySourceObservation: {
    type: "object",
    additionalProperties: false,
    required: [
      "observationId",
      "episodeId",
      "observationOrdinal",
      "observationKind",
      "observedAt",
      "memoryIds",
      "content",
      "contentTruncated",
    ],
    properties: {
      observationId: { type: "string", format: "uuid" },
      episodeId: { type: "string", format: "uuid" },
      observationOrdinal: { type: "integer", minimum: 0 },
      observationKind: { type: "string", enum: [...OBSERVATION_KINDS] },
      observedAt: { type: "string", format: "date-time" },
      memoryIds: {
        type: "array",
        minItems: 1,
        items: { type: "string", format: "uuid" },
      },
      content: { type: "string", maxLength: MAX_OBSERVATION_CONTENT_CHARACTERS },
      contentTruncated: { type: "boolean" },
    },
  },
  MemorySourceRead: {
    type: "object",
    additionalProperties: false,
    required: ["sources", "omittedObservationIds"],
    properties: {
      sources: { type: "array", items: { $ref: "#/components/schemas/MemorySourceObservation" } },
      omittedObservationIds: { type: "array", items: { type: "string", format: "uuid" } },
    },
  },
};

export const episodesPaths = { ...recordingPaths, ...observationEvidencePaths };
export const episodesSchemas = { ...recordingSchemas, ...observationEvidenceSchemas };
