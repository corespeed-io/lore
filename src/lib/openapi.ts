import {
  MEMORY_CHUNK_MAXIMUM_CHARACTERS,
  MEMORY_CHUNK_OVERLAP_CHARACTERS,
  MEMORY_CHUNKING_REVISION,
} from "./memory-chunking";
import { MEMORY_CONTENT_LIMITS } from "./memory-content";
import { LORE_API_VERSION } from "./operations";
import { MAX_WORKSPACE_ARCHIVE_LINKS, MAX_WORKSPACE_ARCHIVE_MEMORIES } from "./portability";

const errorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "error"],
  properties: {
    code: {
      type: "string",
      enum: [
        "access_denied",
        "authentication_required",
        "idempotency_conflict",
        "internal_error",
        "invalid_archive",
        "invalid_request",
        "not_found",
        "precondition_required",
        "proposal_capacity_exceeded",
        "proposal_review_conflict",
        "version_conflict",
        "workspace_export_limit_exceeded",
      ],
    },
    error: { type: "string" },
  },
} as const;

const timestampProperties = {
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

const codeEvidenceRelationshipSchema = {
  type: "string",
  enum: ["supports", "contradicts", "implements", "rationale"],
} as const;

const proposalCodeEvidenceProperty = {
  type: "array",
  maxItems: 50,
  description: "Memory, Observation, and Code evidence have a combined limit of 50.",
  items: { $ref: "#/components/schemas/ProposeMemoryCodeEvidenceInput" },
} as const;

const memorySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "workspaceId",
    "ownerUserId",
    "createdByAgentId",
    "scope",
    "content",
    "metadata",
    "version",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    workspaceId: { type: "string", format: "uuid" },
    ownerUserId: { type: "string", format: "uuid" },
    createdByAgentId: { oneOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
    scope: { type: "string", enum: ["shared", "private"] },
    content: { type: "string", maxLength: MEMORY_CONTENT_LIMITS.maximumCharacters },
    metadata: { type: "object", additionalProperties: true },
    version: { type: "integer", minimum: 1 },
    ...timestampProperties,
  },
} as const;

const memoryProposalUpdateProperties = {
  kind: { const: "update" },
  targetMemoryId: { type: "string", format: "uuid" },
  expectedVersion: { type: "integer", minimum: 1 },
  content: {
    type: "string",
    minLength: 1,
    maxLength: MEMORY_CONTENT_LIMITS.maximumCharacters,
  },
  scope: { type: "string", enum: ["shared", "private"] },
  metadata: { type: "object", additionalProperties: true },
  evidenceMemoryIds: {
    type: "array",
    maxItems: 50,
    description: "Memory, Observation, and Code evidence have a combined limit of 50.",
    items: { type: "string", format: "uuid" },
  },
  evidenceObservationIds: {
    type: "array",
    maxItems: 50,
    description: "Memory, Observation, and Code evidence have a combined limit of 50.",
    items: { type: "string", format: "uuid" },
  },
  codeEvidence: proposalCodeEvidenceProperty,
} as const;

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

function memoryProposalUpdateVariant(change: "content" | "metadata" | "scope") {
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind", "targetMemoryId", "expectedVersion", change],
    properties: memoryProposalUpdateProperties,
  } as const;
}

const workspaceHeader = {
  name: "x-lore-workspace-id",
  in: "header",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", minLength: 1, maxLength: 128 },
} as const;

const ifMatchHeader = {
  name: "If-Match",
  in: "header",
  required: true,
  schema: { type: "string", pattern: '^"memory-v[1-9][0-9]*"$' },
} as const;

const memoryIdParameter = {
  name: "memoryId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

const agentIdParameter = {
  name: "agentId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

const humanSecurity = [
  { basicAuth: [] },
  { cloudflareAccessHeader: [] },
  { cloudflareAccessCookie: [] },
] as const;

const actorSecurity = [{ agentBearer: [] }, ...humanSecurity] as const;

function requestBody(schema: Record<string, unknown>) {
  return {
    required: true,
    content: { "application/json": { schema } },
  };
}

function jsonResponse(description: string, schema: Record<string, unknown>, headers = {}) {
  return {
    description,
    headers,
    content: { "application/json": { schema } },
  };
}

export function loreOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.1",
    info: {
      title: "Lore Portable Core",
      version: LORE_API_VERSION,
      description:
        "RLS-enforced Memory storage, retrieval, portability, and revision-bound Code Evidence. Human authentication is deployment-selected; Agent credentials use Lore bearer tokens.",
    },
    servers: [{ url: "/" }],
    security: actorSecurity,
    paths: {
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
      "/api/v1/code/search": {
        get: {
          operationId: "searchCode",
          parameters: [
            workspaceHeader,
            {
              name: "repository_key",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 1, maxLength: 512 },
            },
            {
              name: "commit_oid",
              in: "query",
              required: true,
              schema: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
            },
            {
              name: "q",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 1, maxLength: 2_000 },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100 },
            },
            {
              name: "path_prefix",
              in: "query",
              schema: { type: "string", minLength: 1, maxLength: 1_024 },
            },
          ],
          responses: {
            "200": jsonResponse("RLS-visible exact-revision Code Artifacts", {
              type: "array",
              items: { $ref: "#/components/schemas/CodeArtifact" },
            }),
          },
        },
      },
      "/api/v1/context/retrieve": {
        post: {
          operationId: "retrieveContext",
          description:
            "Retrieve one bounded packet from Actor-visible Memory and an optional exact-revision Code Index. Code Evidence assessment is side-effect-free and does not update canonical Memory or citation state.",
          parameters: [workspaceHeader],
          requestBody: requestBody({ $ref: "#/components/schemas/RetrieveContextInput" }),
          responses: {
            "200": jsonResponse("Bounded, provenance-bearing Memory and Code context", {
              $ref: "#/components/schemas/RetrievedContext",
            }),
            "400": { $ref: "#/components/responses/Error" },
            "403": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/v1/code/dependencies": {
        get: {
          operationId: "queryCodeDependencies",
          description:
            "Return bounded callers or callees from one Workspace-visible repository, exact full commit OID, and active Code Index Generation. Exactly one of symbol or path is required.",
          parameters: [
            workspaceHeader,
            {
              name: "repository_key",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 1, maxLength: 512 },
            },
            {
              name: "commit_oid",
              in: "query",
              required: true,
              schema: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
            },
            {
              name: "direction",
              in: "query",
              required: true,
              schema: { type: "string", enum: ["callers", "callees"] },
            },
            {
              name: "symbol",
              in: "query",
              schema: { type: "string", minLength: 1, maxLength: 1_600 },
            },
            {
              name: "path",
              in: "query",
              schema: { type: "string", minLength: 1, maxLength: 1_024 },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            "200": jsonResponse("Bounded exact-revision Code Dependency result", {
              $ref: "#/components/schemas/CodeDependencyQueryResult",
            }),
            "400": { $ref: "#/components/responses/Error" },
            "403": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/v1/code/index-jobs/{jobId}": {
        get: {
          operationId: "getCodeIndexJob",
          parameters: [
            workspaceHeader,
            {
              name: "jobId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": jsonResponse("Safe Code Index job status", {
              $ref: "#/components/schemas/CodeIndexJob",
            }),
          },
        },
      },
      "/api/v1/code/index-jobs": {
        get: {
          operationId: "listCodeIndexJobs",
          parameters: [
            workspaceHeader,
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: {
            "200": jsonResponse("Bounded newest-first Code Index job status for the Workspace", {
              type: "array",
              items: { $ref: "#/components/schemas/CodeIndexJob" },
            }),
            "400": { $ref: "#/components/responses/Error" },
            "403": { $ref: "#/components/responses/Error" },
          },
        },
        post: {
          operationId: "enqueueCodeIndex",
          parameters: [workspaceHeader],
          requestBody: requestBody({ $ref: "#/components/schemas/EnqueueCodeIndexInput" }),
          responses: {
            "202": jsonResponse("Queued exact revision from an operator-configured repository", {
              $ref: "#/components/schemas/CodeIndexJob",
            }),
          },
        },
      },
      "/api/v1/memories/{memoryId}/code-evidence": {
        get: {
          operationId: "listMemoryCodeEvidence",
          parameters: [workspaceHeader, memoryIdParameter],
          responses: {
            "200": jsonResponse("Typed Code Evidence visible with the Memory", {
              type: "array",
              items: { $ref: "#/components/schemas/MemoryCodeEvidence" },
            }),
          },
        },
        post: {
          operationId: "citeMemoryCodeEvidence",
          parameters: [workspaceHeader, memoryIdParameter],
          requestBody: requestBody({ $ref: "#/components/schemas/CiteMemoryCodeEvidenceInput" }),
          responses: {
            "201": jsonResponse("Created immutable Code Evidence citation", {
              $ref: "#/components/schemas/MemoryCodeEvidence",
            }),
          },
        },
      },
      "/api/v1/code-evidence/{evidenceId}/revalidate": {
        post: {
          operationId: "revalidateMemoryCodeEvidence",
          parameters: [
            workspaceHeader,
            {
              name: "evidenceId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: requestBody({
            $ref: "#/components/schemas/RevalidateMemoryCodeEvidenceInput",
          }),
          responses: {
            "200": jsonResponse("Revalidated Code Evidence without changing Memory", {
              $ref: "#/components/schemas/MemoryCodeEvidence",
            }),
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
      "/api/v1/memory-proposals": {
        get: {
          operationId: "listMemoryProposals",
          security: humanSecurity,
          parameters: [
            workspaceHeader,
            {
              name: "status",
              in: "query",
              schema: { type: "string", enum: ["pending", "accepted", "rejected"] },
            },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          ],
          responses: {
            "200": jsonResponse("Owner-private Memory Proposals", {
              type: "array",
              items: { $ref: "#/components/schemas/MemoryProposal" },
            }),
            "403": { $ref: "#/components/responses/Error" },
          },
        },
        post: {
          operationId: "createMemoryProposal",
          parameters: [workspaceHeader, idempotencyHeader],
          requestBody: requestBody({ $ref: "#/components/schemas/CreateMemoryProposalInput" }),
          responses: {
            "201": jsonResponse("Submitted owner-private Memory Proposal", {
              $ref: "#/components/schemas/MemoryProposal",
            }),
            "403": { $ref: "#/components/responses/Error" },
            "409": { $ref: "#/components/responses/Error" },
            "412": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/v1/memory-proposals/{proposalId}/review": {
        post: {
          operationId: "reviewMemoryProposal",
          security: humanSecurity,
          parameters: [
            workspaceHeader,
            {
              name: "proposalId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          requestBody: requestBody({
            type: "object",
            additionalProperties: false,
            required: ["decision"],
            properties: { decision: { type: "string", enum: ["accept", "reject"] } },
          }),
          responses: {
            "200": jsonResponse(
              "Reviewed Memory Proposal",
              { $ref: "#/components/schemas/MemoryProposalReviewResult" },
              { ETag: { schema: { type: "string" } } },
            ),
            "403": { $ref: "#/components/responses/Error" },
            "404": { $ref: "#/components/responses/Error" },
            "409": { $ref: "#/components/responses/Error" },
            "412": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/v1/graph": {
        get: {
          operationId: "getMemoryGraph",
          parameters: [
            workspaceHeader,
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 5_000 } },
          ],
          responses: {
            "200": jsonResponse("Actor-visible graph with authorized endpoints", {
              $ref: "#/components/schemas/MemoryGraph",
            }),
          },
        },
      },
      "/api/v1/agents": {
        get: {
          operationId: "listAgents",
          security: humanSecurity,
          parameters: [workspaceHeader],
          responses: {
            "200": jsonResponse("User-private Agents", {
              type: "array",
              items: { $ref: "#/components/schemas/WorkspaceAgent" },
            }),
          },
        },
        post: {
          operationId: "createAgent",
          security: humanSecurity,
          parameters: [workspaceHeader],
          requestBody: requestBody({
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 120 },
              permission: { type: "string", enum: ["read", "write"], default: "read" },
            },
          }),
          responses: {
            "201": jsonResponse("Created Agent", {
              $ref: "#/components/schemas/WorkspaceAgent",
            }),
          },
        },
      },
      "/api/v1/agents/{agentId}": {
        patch: {
          operationId: "updateAgent",
          security: humanSecurity,
          parameters: [workspaceHeader, agentIdParameter],
          requestBody: requestBody({ $ref: "#/components/schemas/UpdateAgentInput" }),
          responses: {
            "200": jsonResponse("Updated global Agent identity and status", {
              $ref: "#/components/schemas/WorkspaceAgent",
            }),
            "404": { $ref: "#/components/responses/Error" },
          },
        },
        delete: {
          operationId: "deleteAgent",
          security: humanSecurity,
          parameters: [workspaceHeader, agentIdParameter],
          responses: {
            "204": { description: "Disabled Agent, grants, and credentials deleted" },
            "404": { $ref: "#/components/responses/Error" },
            "409": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/v1/agents/{agentId}/credentials": {
        get: {
          operationId: "listAgentCredentials",
          security: humanSecurity,
          parameters: [workspaceHeader, agentIdParameter],
          responses: {
            "200": jsonResponse("Agent credential metadata without secret hashes", {
              type: "array",
              items: { $ref: "#/components/schemas/AgentCredential" },
            }),
          },
        },
        post: {
          operationId: "issueAgentCredential",
          security: humanSecurity,
          parameters: [workspaceHeader, agentIdParameter],
          responses: {
            "201": jsonResponse("One-time Agent credential", {
              $ref: "#/components/schemas/IssuedAgentCredential",
            }),
          },
        },
      },
      "/api/v1/agents/{agentId}/grant": {
        put: {
          operationId: "setAgentGrant",
          security: humanSecurity,
          parameters: [workspaceHeader, agentIdParameter],
          requestBody: requestBody({
            type: "object",
            additionalProperties: false,
            required: ["permission"],
            properties: { permission: { type: "string", enum: ["read", "write"] } },
          }),
          responses: {
            "200": jsonResponse("Active Agent Workspace grant", {
              $ref: "#/components/schemas/AgentWorkspaceGrant",
            }),
          },
        },
        delete: {
          operationId: "revokeAgentGrant",
          security: humanSecurity,
          parameters: [workspaceHeader, agentIdParameter],
          responses: { "204": { description: "Grant revoked" } },
        },
      },
      "/api/v1/agent-credentials/{credentialId}": {
        delete: {
          operationId: "revokeAgentCredential",
          security: humanSecurity,
          parameters: [
            workspaceHeader,
            {
              name: "credentialId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: { "204": { description: "Credential revoked" } },
        },
      },
      "/api/v1/evaluations/suites": {
        get: {
          operationId: "listEvaluationSuites",
          security: humanSecurity,
          parameters: [workspaceHeader],
          responses: {
            "200": jsonResponse("Workspace Evaluation Suites", {
              type: "array",
              items: { $ref: "#/components/schemas/EvaluationSuite" },
            }),
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
      "/api/v1/workspaces/export": {
        get: {
          operationId: "exportWorkspace",
          security: humanSecurity,
          parameters: [workspaceHeader],
          responses: {
            "200": jsonResponse("Versioned actor-visible Workspace archive", {
              $ref: "#/components/schemas/WorkspaceArchive",
            }),
            "409": { $ref: "#/components/responses/Error" },
          },
        },
      },
      "/api/v1/workspaces/import": {
        post: {
          operationId: "importWorkspace",
          security: humanSecurity,
          parameters: [workspaceHeader],
          requestBody: requestBody({ $ref: "#/components/schemas/ImportWorkspaceInput" }),
          responses: {
            "200": jsonResponse("Dry-run or completed import", {
              $ref: "#/components/schemas/WorkspaceImportResult",
            }),
          },
        },
      },
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
    },
    components: {
      schemas: {
        Error: errorSchema,
        Memory: memorySchema,
        CreateMemoryInput: {
          type: "object",
          additionalProperties: false,
          required: ["content"],
          properties: {
            content: {
              type: "string",
              minLength: 1,
              maxLength: MEMORY_CONTENT_LIMITS.maximumCharacters,
            },
            scope: { type: "string", enum: ["shared", "private"], default: "shared" },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        UpdateMemoryInput: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            content: {
              type: "string",
              minLength: 1,
              maxLength: MEMORY_CONTENT_LIMITS.maximumCharacters,
            },
            scope: { type: "string", enum: ["shared", "private"] },
            metadata: { type: "object", additionalProperties: true },
          },
        },
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
        CreateMemoryProposalInput: {
          oneOf: [
            { $ref: "#/components/schemas/CreateMemoryProposalCreateInput" },
            { $ref: "#/components/schemas/CreateMemoryProposalUpdateInput" },
          ],
        },
        CreateMemoryProposalCreateInput: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "content"],
          properties: {
            kind: { const: "create" },
            content: {
              type: "string",
              minLength: 1,
              maxLength: MEMORY_CONTENT_LIMITS.maximumCharacters,
            },
            scope: { type: "string", enum: ["shared", "private"], default: "shared" },
            metadata: { type: "object", additionalProperties: true },
            evidenceMemoryIds: {
              type: "array",
              maxItems: 50,
              description: "Memory, Observation, and Code evidence have a combined limit of 50.",
              items: { type: "string", format: "uuid" },
            },
            evidenceObservationIds: {
              type: "array",
              maxItems: 50,
              description: "Memory, Observation, and Code evidence have a combined limit of 50.",
              items: { type: "string", format: "uuid" },
            },
            codeEvidence: proposalCodeEvidenceProperty,
          },
        },
        CreateMemoryProposalUpdateInput: {
          anyOf: [
            { $ref: "#/components/schemas/MemoryProposalUpdateContentInput" },
            { $ref: "#/components/schemas/MemoryProposalUpdateScopeInput" },
            { $ref: "#/components/schemas/MemoryProposalUpdateMetadataInput" },
          ],
        },
        MemoryProposalUpdateContentInput: memoryProposalUpdateVariant("content"),
        MemoryProposalUpdateScopeInput: memoryProposalUpdateVariant("scope"),
        MemoryProposalUpdateMetadataInput: memoryProposalUpdateVariant("metadata"),
        ProposeMemoryCodeEvidenceInput: {
          type: "object",
          additionalProperties: false,
          required: ["artifactId", "relationship"],
          properties: {
            artifactId: { type: "string", format: "uuid" },
            relationship: codeEvidenceRelationshipSchema,
          },
        },
        MemoryProposalCodeEvidence: {
          type: "object",
          additionalProperties: false,
          required: [
            "ordinal",
            "repositoryId",
            "citedRevisionId",
            "citedGenerationId",
            "citedArtifactId",
            "citedCommitOid",
            "citedPath",
            "citedSymbolKey",
            "citedDeclarationKey",
            "citedDeclarationChunkOrdinal",
            "citedDeclarationContextSha256",
            "citedContentSha256",
            "relationship",
          ],
          properties: {
            ordinal: { type: "integer", minimum: 0, maximum: 49 },
            repositoryId: { type: "string", format: "uuid" },
            citedRevisionId: { type: "string", format: "uuid" },
            citedGenerationId: { type: "string", format: "uuid" },
            citedArtifactId: { type: "string", format: "uuid" },
            citedCommitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
            citedPath: { type: "string", minLength: 1, maxLength: 1024 },
            citedSymbolKey: { oneOf: [{ type: "string" }, { type: "null" }] },
            citedDeclarationKey: { oneOf: [{ type: "string" }, { type: "null" }] },
            citedDeclarationChunkOrdinal: {
              oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
            },
            citedDeclarationContextSha256: {
              oneOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }],
            },
            citedContentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
            relationship: codeEvidenceRelationshipSchema,
          },
        },
        MemoryProposal: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "workspaceId",
            "ownerUserId",
            "proposedByActorKind",
            "proposedByAgentId",
            "kind",
            "targetMemoryId",
            "baseMemoryVersion",
            "proposedContent",
            "proposedScope",
            "proposedMetadata",
            "evidenceMemoryIds",
            "evidenceObservationIds",
            "codeEvidence",
            "status",
            "reviewedByUserId",
            "acceptedMemoryId",
            "createdAt",
            "reviewedAt",
          ],
          properties: {
            id: { type: "string", format: "uuid" },
            workspaceId: { type: "string", format: "uuid" },
            ownerUserId: { type: "string", format: "uuid" },
            proposedByActorKind: { type: "string", enum: ["human", "agent"] },
            proposedByAgentId: {
              oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
            },
            kind: { type: "string", enum: ["create", "update"] },
            targetMemoryId: {
              oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
            },
            baseMemoryVersion: {
              oneOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
            },
            proposedContent: {
              type: "string",
              minLength: 1,
              maxLength: MEMORY_CONTENT_LIMITS.maximumCharacters,
            },
            proposedScope: { type: "string", enum: ["shared", "private"] },
            proposedMetadata: { type: "object", additionalProperties: true },
            evidenceMemoryIds: {
              type: "array",
              maxItems: 50,
              items: { type: "string", format: "uuid" },
            },
            evidenceObservationIds: {
              type: "array",
              maxItems: 50,
              items: { type: "string", format: "uuid" },
            },
            codeEvidence: {
              type: "array",
              maxItems: 50,
              items: { $ref: "#/components/schemas/MemoryProposalCodeEvidence" },
            },
            status: { type: "string", enum: ["pending", "accepted", "rejected"] },
            reviewedByUserId: {
              oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
            },
            acceptedMemoryId: {
              oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
            },
            createdAt: { type: "string", format: "date-time" },
            reviewedAt: {
              oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
            },
          },
        },
        MemoryProposalReviewResult: {
          type: "object",
          additionalProperties: false,
          required: ["proposal", "memory"],
          properties: {
            proposal: { $ref: "#/components/schemas/MemoryProposal" },
            memory: { oneOf: [{ $ref: "#/components/schemas/Memory" }, { type: "null" }] },
          },
        },
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
        RetrieveContextInput: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1, maxLength: 10_000 },
            memoryQuery: { type: "string", minLength: 1, maxLength: 10_000 },
            codeQuery: { type: "string", minLength: 1, maxLength: 2_000 },
            repositoryKey: { type: "string", minLength: 1, maxLength: 512 },
            commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
            route: {
              type: "string",
              enum: ["auto", "both", "code-only", "memory-only"],
              default: "auto",
            },
            memoryLimit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
            codeLimit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
            scope: { type: "string", enum: ["shared", "private"] },
            metadata: { type: "object", additionalProperties: true },
            pathPrefix: { type: "string", minLength: 1, maxLength: 1_024 },
          },
        },
        ContextRetrievalPlan: {
          type: "object",
          additionalProperties: false,
          required: [
            "intent",
            "route",
            "needsAnchorExpansion",
            "needsContextualImpact",
            "needsLocalAssessment",
            "reasons",
          ],
          properties: {
            intent: {
              type: "string",
              enum: [
                "blast-radius",
                "change",
                "current-code",
                "memory-recall",
                "rationale",
                "unknown",
              ],
            },
            route: {
              type: "string",
              enum: ["abstain", "both", "code-only", "memory-only"],
            },
            needsAnchorExpansion: { type: "boolean" },
            needsContextualImpact: { type: "boolean" },
            needsLocalAssessment: { type: "boolean" },
            reasons: { type: "array", items: { type: "string" } },
          },
        },
        RetrievedMemoryContext: {
          type: "object",
          additionalProperties: false,
          required: ["id", "scope", "updatedAt", "score", "evidence"],
          properties: {
            id: { type: "string", format: "uuid" },
            scope: { type: "string", enum: ["shared", "private"] },
            updatedAt: { type: "string", format: "date-time" },
            score: { type: "number" },
            rerankScore: { type: "number", minimum: 0, maximum: 1 },
            evidence: { type: "string" },
          },
        },
        RetrievedCodeContext: {
          type: "object",
          additionalProperties: false,
          required: [
            "artifactId",
            "commitOid",
            "path",
            "symbol",
            "startLine",
            "endLine",
            "score",
            "matchedChannels",
            "content",
          ],
          properties: {
            artifactId: { type: "string", format: "uuid" },
            commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
            path: { type: "string" },
            symbol: { oneOf: [{ type: "string" }, { type: "null" }] },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
            score: { type: "number" },
            matchedChannels: {
              type: "array",
              uniqueItems: true,
              items: { type: "string", enum: ["symbol", "literal", "lexical", "path"] },
            },
            content: { type: "string", maxLength: 6_000 },
          },
        },
        RetrievedAnchorContext: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "memoryId",
            "relationship",
            "localState",
            "citedCommitOid",
            "citedPath",
            "validatedCommitOid",
            "validatedPath",
          ],
          properties: {
            id: { type: "string", format: "uuid" },
            memoryId: { type: "string", format: "uuid" },
            relationship: {
              type: "string",
              enum: ["supports", "contradicts", "implements", "rationale"],
            },
            localState: {
              type: "string",
              enum: ["current", "moved", "changed", "deleted", "ambiguous", "unverifiable"],
            },
            citedCommitOid: {
              type: "string",
              pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$",
            },
            citedPath: { type: "string" },
            validatedCommitOid: {
              oneOf: [
                { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
                { type: "null" },
              ],
            },
            validatedPath: { oneOf: [{ type: "string" }, { type: "null" }] },
          },
        },
        ContextualImpactAssessment: {
          type: "object",
          additionalProperties: false,
          required: ["state", "changes"],
          properties: {
            state: {
              type: "string",
              enum: ["affected", "possibly_affected", "unaffected", "unknown"],
            },
            changes: {
              type: "array",
              maxItems: 251,
              items: { type: "string", maxLength: 2_500 },
            },
          },
        },
        ContextRetrievalReceipt: {
          type: "object",
          additionalProperties: false,
          required: [
            "memoryCandidates",
            "codeCandidates",
            "anchorCandidates",
            "requestedCommitOid",
            "memoryQuery",
            "codeQuery",
            "contextualImpact",
          ],
          properties: {
            memoryCandidates: { type: "integer", minimum: 0, maximum: 10 },
            codeCandidates: { type: "integer", minimum: 0, maximum: 20 },
            anchorCandidates: { type: "integer", minimum: 0, maximum: 25 },
            requestedCommitOid: {
              oneOf: [
                { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
                { type: "null" },
              ],
            },
            memoryQuery: { oneOf: [{ type: "string" }, { type: "null" }] },
            codeQuery: { oneOf: [{ type: "string" }, { type: "null" }] },
            contextualImpact: {
              oneOf: [
                { $ref: "#/components/schemas/ContextualImpactAssessment" },
                { type: "null" },
              ],
            },
          },
        },
        RetrievedContext: {
          type: "object",
          additionalProperties: false,
          required: [
            "revision",
            "query",
            "plan",
            "deliveredRoute",
            "memories",
            "code",
            "anchors",
            "conflicts",
            "receipt",
          ],
          properties: {
            revision: { const: "joint-memory-code-v2" },
            query: { type: "string" },
            plan: { $ref: "#/components/schemas/ContextRetrievalPlan" },
            deliveredRoute: {
              type: "string",
              enum: ["abstain", "both", "code-only", "memory-only"],
            },
            memories: {
              type: "array",
              maxItems: 10,
              items: { $ref: "#/components/schemas/RetrievedMemoryContext" },
            },
            code: {
              type: "array",
              maxItems: 20,
              items: { $ref: "#/components/schemas/RetrievedCodeContext" },
            },
            anchors: {
              type: "array",
              maxItems: 25,
              items: { $ref: "#/components/schemas/RetrievedAnchorContext" },
            },
            conflicts: { type: "array", items: { type: "string" } },
            receipt: { $ref: "#/components/schemas/ContextRetrievalReceipt" },
          },
        },
        CodeArtifactSymbol: {
          type: "object",
          additionalProperties: false,
          required: ["symbol", "symbolKey", "declarationKey"],
          properties: {
            symbol: { type: "string" },
            symbolKey: { type: "string" },
            declarationKey: { type: "string" },
          },
        },
        CodeArtifact: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "repositoryId",
            "revisionId",
            "generationId",
            "commitOid",
            "path",
            "language",
            "parser",
            "parseStatus",
            "kind",
            "symbol",
            "symbolKey",
            "declarationKey",
            "declarationChunkOrdinal",
            "symbols",
            "ordinal",
            "startLine",
            "endLine",
            "content",
            "contentSha256",
            "matchedChannels",
            "score",
          ],
          properties: {
            id: { type: "string", format: "uuid" },
            repositoryId: { type: "string", format: "uuid" },
            revisionId: { type: "string", format: "uuid" },
            generationId: { type: "string", format: "uuid" },
            commitOid: { type: "string" },
            path: { type: "string" },
            language: { type: "string" },
            parser: { type: "string", enum: ["tree_sitter", "text"] },
            parseStatus: { type: "string", enum: ["parsed", "recovered", "fallback"] },
            kind: { type: "string" },
            symbol: { oneOf: [{ type: "string" }, { type: "null" }] },
            symbolKey: { oneOf: [{ type: "string" }, { type: "null" }] },
            declarationKey: { oneOf: [{ type: "string" }, { type: "null" }] },
            declarationChunkOrdinal: {
              oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
            },
            symbols: {
              type: "array",
              items: { $ref: "#/components/schemas/CodeArtifactSymbol" },
            },
            ordinal: { type: "integer", minimum: 0 },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
            content: { type: "string", maxLength: 6_000 },
            contentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
            matchedChannels: {
              type: "array",
              uniqueItems: true,
              items: { type: "string", enum: ["symbol", "literal", "lexical", "path"] },
            },
            score: { type: "number" },
          },
        },
        CodeGraphLocator: {
          type: "object",
          additionalProperties: false,
          required: ["artifactId", "path", "symbol", "symbolKey"],
          properties: {
            artifactId: {
              oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
            },
            path: { oneOf: [{ type: "string" }, { type: "null" }] },
            symbol: { oneOf: [{ type: "string" }, { type: "null" }] },
            symbolKey: { oneOf: [{ type: "string" }, { type: "null" }] },
          },
        },
        CodeDependencySite: {
          type: "object",
          additionalProperties: false,
          required: ["path", "startLine", "startColumn", "endLine", "endColumn"],
          properties: {
            path: { type: "string" },
            startLine: { type: "integer", minimum: 1 },
            startColumn: { type: "integer", minimum: 0 },
            endLine: { type: "integer", minimum: 1 },
            endColumn: { type: "integer", minimum: 0 },
          },
        },
        CodeDependencyEdge: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "resolution", "targetText", "from", "to", "site"],
          properties: {
            id: { type: "string", format: "uuid" },
            kind: { type: "string", enum: ["calls", "imports", "references"] },
            resolution: {
              type: "string",
              enum: ["resolved", "ambiguous", "unresolved"],
            },
            targetText: { type: "string", minLength: 1, maxLength: 1_600 },
            from: { $ref: "#/components/schemas/CodeGraphLocator" },
            to: { $ref: "#/components/schemas/CodeGraphLocator" },
            site: { $ref: "#/components/schemas/CodeDependencySite" },
          },
        },
        CodeDependencyQueryOk: {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "repositoryKey",
            "commitOid",
            "direction",
            "subject",
            "edges",
            "truncated",
          ],
          properties: {
            status: { const: "ok" },
            repositoryKey: { type: "string" },
            commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
            direction: { type: "string", enum: ["callers", "callees"] },
            subject: { $ref: "#/components/schemas/CodeGraphLocator" },
            edges: {
              type: "array",
              maxItems: 200,
              items: { $ref: "#/components/schemas/CodeDependencyEdge" },
            },
            truncated: { type: "boolean" },
          },
        },
        CodeDependencyQueryAmbiguous: {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "repositoryKey",
            "commitOid",
            "direction",
            "candidates",
            "truncated",
          ],
          properties: {
            status: { const: "ambiguous" },
            repositoryKey: { type: "string" },
            commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
            direction: { type: "string", enum: ["callers", "callees"] },
            candidates: {
              type: "array",
              minItems: 2,
              maxItems: 200,
              items: { $ref: "#/components/schemas/CodeGraphLocator" },
            },
            truncated: { type: "boolean" },
          },
        },
        CodeDependencyQueryNotFound: {
          type: "object",
          additionalProperties: false,
          required: ["status", "repositoryKey", "commitOid", "direction", "candidates"],
          properties: {
            status: { const: "not_found" },
            repositoryKey: { type: "string" },
            commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
            direction: { type: "string", enum: ["callers", "callees"] },
            candidates: {
              type: "array",
              maxItems: 0,
              items: { $ref: "#/components/schemas/CodeGraphLocator" },
            },
          },
        },
        CodeDependencyQueryResult: {
          oneOf: [
            { $ref: "#/components/schemas/CodeDependencyQueryOk" },
            { $ref: "#/components/schemas/CodeDependencyQueryAmbiguous" },
            { $ref: "#/components/schemas/CodeDependencyQueryNotFound" },
          ],
        },
        CodeIndexJob: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "repositoryId",
            "repositoryKey",
            "commitOid",
            "sourceRef",
            "indexerRevision",
            "status",
            "attemptCount",
            "maximumAttempts",
            "availableAt",
            "completedAt",
            "lastError",
            "createdAt",
            "updatedAt",
          ],
          properties: {
            id: { type: "string", format: "uuid" },
            repositoryId: { type: "string", format: "uuid" },
            repositoryKey: { type: "string" },
            commitOid: { type: "string" },
            sourceRef: { oneOf: [{ type: "string" }, { type: "null" }] },
            indexerRevision: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "processing", "succeeded", "dead", "cancelled"],
            },
            attemptCount: { type: "integer", minimum: 0 },
            maximumAttempts: { type: "integer", minimum: 1 },
            availableAt: { type: "string", format: "date-time" },
            completedAt: {
              oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
            },
            lastError: { oneOf: [{ type: "string" }, { type: "null" }] },
            ...timestampProperties,
          },
        },
        EnqueueCodeIndexInput: {
          type: "object",
          additionalProperties: false,
          required: ["repositoryKey", "commitOid"],
          properties: {
            repositoryKey: { type: "string", minLength: 1, maxLength: 512 },
            commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
            sourceRef: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
        CiteMemoryCodeEvidenceInput: {
          type: "object",
          additionalProperties: false,
          required: ["artifactId", "relationship"],
          properties: {
            artifactId: { type: "string", format: "uuid" },
            relationship: {
              type: "string",
              enum: ["supports", "contradicts", "implements", "rationale"],
            },
          },
        },
        RevalidateMemoryCodeEvidenceInput: {
          type: "object",
          additionalProperties: false,
          required: ["repositoryKey", "commitOid"],
          properties: {
            repositoryKey: { type: "string", minLength: 1, maxLength: 512 },
            commitOid: { type: "string", pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" },
          },
        },
        MemoryCodeEvidence: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "memoryId",
            "repositoryId",
            "citedRevisionId",
            "citedGenerationId",
            "citedArtifactId",
            "citedCommitOid",
            "citedPath",
            "citedSymbolKey",
            "citedDeclarationKey",
            "citedDeclarationChunkOrdinal",
            "citedDeclarationContextSha256",
            "citedContentSha256",
            "relationship",
            "validationState",
            "validatedRevisionId",
            "validatedGenerationId",
            "validatedArtifactId",
            "validatedCommitOid",
            "validatedPath",
            "createdByUserId",
            "createdByAgentId",
            "createdAt",
            "validatedAt",
          ],
          properties: {
            id: { type: "string", format: "uuid" },
            memoryId: { type: "string", format: "uuid" },
            repositoryId: { type: "string", format: "uuid" },
            citedRevisionId: { type: "string", format: "uuid" },
            citedGenerationId: { type: "string", format: "uuid" },
            citedArtifactId: { type: "string", format: "uuid" },
            citedCommitOid: { type: "string" },
            citedPath: { type: "string" },
            citedSymbolKey: { oneOf: [{ type: "string" }, { type: "null" }] },
            citedDeclarationKey: { oneOf: [{ type: "string" }, { type: "null" }] },
            citedDeclarationChunkOrdinal: {
              oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
            },
            citedDeclarationContextSha256: {
              oneOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }],
            },
            citedContentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
            relationship: {
              type: "string",
              enum: ["supports", "contradicts", "implements", "rationale"],
            },
            validationState: {
              type: "string",
              enum: ["current", "moved", "changed", "deleted", "ambiguous", "unverifiable"],
            },
            validatedRevisionId: {
              oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
            },
            validatedGenerationId: {
              oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
            },
            validatedArtifactId: {
              oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
            },
            validatedCommitOid: { oneOf: [{ type: "string" }, { type: "null" }] },
            validatedPath: { oneOf: [{ type: "string" }, { type: "null" }] },
            createdByUserId: { type: "string", format: "uuid" },
            createdByAgentId: {
              oneOf: [{ type: "string", format: "uuid" }, { type: "null" }],
            },
            createdAt: { type: "string", format: "date-time" },
            validatedAt: { type: "string", format: "date-time" },
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
        HumanActor: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "userId"],
          properties: {
            kind: { const: "human" },
            userId: { type: "string", format: "uuid" },
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
        WorkspaceAgent: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "ownerUserId",
            "name",
            "status",
            "permission",
            "grantStatus",
            "createdAt",
            "updatedAt",
          ],
          properties: {
            id: { type: "string", format: "uuid" },
            ownerUserId: { type: "string", format: "uuid" },
            name: { type: "string" },
            status: { type: "string", enum: ["active", "disabled"] },
            permission: { type: "string", enum: ["read", "write"] },
            grantStatus: { type: "string", enum: ["active", "revoked"] },
            ...timestampProperties,
          },
        },
        UpdateAgentInput: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            status: { type: "string", enum: ["active", "disabled"] },
          },
        },
        AgentWorkspaceGrant: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId", "agentId", "permission", "status", "createdAt", "updatedAt"],
          properties: {
            workspaceId: { type: "string", format: "uuid" },
            agentId: { type: "string", format: "uuid" },
            permission: { type: "string", enum: ["read", "write"] },
            status: { type: "string", enum: ["active", "revoked"] },
            ...timestampProperties,
          },
        },
        AgentCredential: {
          type: "object",
          additionalProperties: false,
          required: ["id", "agentId", "prefix", "createdAt", "lastUsedAt", "revokedAt"],
          properties: {
            id: { type: "string", format: "uuid" },
            agentId: { type: "string", format: "uuid" },
            prefix: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            lastUsedAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
            revokedAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
          },
        },
        IssuedAgentCredential: {
          type: "object",
          additionalProperties: false,
          required: ["id", "prefix", "token"],
          properties: {
            id: { type: "string", format: "uuid" },
            prefix: { type: "string" },
            token: { type: "string", readOnly: true },
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
          required: [
            "id",
            "caseId",
            "retrievedMemoryIds",
            "metrics",
            "latencyMs",
            "estimatedCostUsd",
          ],
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
        WorkspaceArchiveMemory: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "ownerUserId",
            "scope",
            "content",
            "metadata",
            "version",
            "createdAt",
            "updatedAt",
          ],
          properties: {
            id: { type: "string", format: "uuid" },
            ownerUserId: { type: "string", format: "uuid" },
            scope: { type: "string", enum: ["shared", "private"] },
            content: {
              type: "string",
              minLength: 1,
              maxLength: MEMORY_CONTENT_LIMITS.maximumCharacters,
            },
            metadata: { type: "object", additionalProperties: true },
            version: { type: "integer", minimum: 1 },
            ...timestampProperties,
          },
        },
        WorkspaceArchiveLink: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
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
            sourceMemoryId: { type: "string", format: "uuid" },
            targetMemoryId: { type: "string", format: "uuid" },
            kind: { type: "string", minLength: 1, maxLength: 64 },
            weight: { type: "number", minimum: 0, maximum: 1 },
            metadata: { type: "object", additionalProperties: true },
            ...timestampProperties,
          },
        },
        WorkspaceArchiveManifest: {
          type: "object",
          additionalProperties: false,
          required: [
            "checksum",
            "exportedAt",
            "format",
            "memoryCount",
            "linkCount",
            "sourceDeploymentId",
            "sourceWorkspaceId",
            "visibility",
          ],
          properties: {
            checksum: { type: "string", pattern: "^[0-9a-f]{64}$" },
            exportedAt: { type: "string", format: "date-time" },
            format: { const: "lore-workspace-v1" },
            memoryCount: {
              type: "integer",
              minimum: 0,
              maximum: MAX_WORKSPACE_ARCHIVE_MEMORIES,
            },
            linkCount: {
              type: "integer",
              minimum: 0,
              maximum: MAX_WORKSPACE_ARCHIVE_LINKS,
            },
            sourceDeploymentId: { type: "string", format: "uuid" },
            sourceWorkspaceId: { type: "string", format: "uuid" },
            visibility: { const: "actor-visible" },
          },
        },
        WorkspaceArchive: {
          type: "object",
          additionalProperties: false,
          required: ["manifest", "memories", "links"],
          properties: {
            manifest: { $ref: "#/components/schemas/WorkspaceArchiveManifest" },
            memories: {
              type: "array",
              maxItems: MAX_WORKSPACE_ARCHIVE_MEMORIES,
              items: { $ref: "#/components/schemas/WorkspaceArchiveMemory" },
            },
            links: {
              type: "array",
              maxItems: MAX_WORKSPACE_ARCHIVE_LINKS,
              items: { $ref: "#/components/schemas/WorkspaceArchiveLink" },
            },
          },
        },
        ImportWorkspaceInput: {
          type: "object",
          additionalProperties: false,
          required: ["archive", "ownerMap"],
          properties: {
            archive: { $ref: "#/components/schemas/WorkspaceArchive" },
            ownerMap: {
              type: "object",
              additionalProperties: { type: "string", format: "uuid" },
            },
            dryRun: { type: "boolean", default: false },
            conflictPolicy: { type: "string", enum: ["error", "remap", "skip"], default: "remap" },
          },
        },
        WorkspaceImportResult: {
          type: "object",
          additionalProperties: false,
          required: [
            "archiveChecksum",
            "dryRun",
            "importedLinks",
            "importedMemories",
            "memoryIdMap",
            "replayed",
            "skippedMemories",
          ],
          properties: {
            archiveChecksum: { type: "string", pattern: "^[0-9a-f]{64}$" },
            dryRun: { type: "boolean" },
            importedLinks: { type: "integer", minimum: 0 },
            importedMemories: { type: "integer", minimum: 0 },
            memoryIdMap: {
              type: "object",
              additionalProperties: { type: "string", format: "uuid" },
            },
            replayed: { type: "boolean" },
            skippedMemories: { type: "integer", minimum: 0 },
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
      },
      responses: {
        Error: {
          description: "Stable Lore error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
      securitySchemes: {
        agentBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "lore_agent_<64 lowercase hex characters>",
        },
        basicAuth: { type: "http", scheme: "basic" },
        cloudflareAccessHeader: {
          type: "apiKey",
          in: "header",
          name: "cf-access-jwt-assertion",
        },
        cloudflareAccessCookie: { type: "apiKey", in: "cookie", name: "CF_Authorization" },
      },
    },
  };
}
