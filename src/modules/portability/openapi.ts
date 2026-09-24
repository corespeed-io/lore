import { MEMORY_CONTENT_LIMITS } from "@corespeed/lore-core";
import {
  humanSecurity,
  jsonResponse,
  requestBody,
  timestampProperties,
  workspaceHeader,
} from "@/server/openapi/shared";
import { MAX_WORKSPACE_ARCHIVE_LINKS, MAX_WORKSPACE_ARCHIVE_MEMORIES } from "./service";

export const portabilityPaths = {
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
        "413": { $ref: "#/components/responses/Error" },
      },
    },
  },
};

export const portabilitySchemas = {
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
};
