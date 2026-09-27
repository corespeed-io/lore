import { MEMORY_METADATA_LIMITS, MEMORY_SCOPES } from "@corespeed/lore-core";
import { LORE_ERROR_CODES } from "@/server/errors";

export const errorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "error"],
  properties: {
    code: {
      type: "string",
      enum: [...LORE_ERROR_CODES],
    },
    error: { type: "string" },
  },
} as const;

/** A Memory scope; Episodes, Proposals, and archives carry the same value. */
export const memoryScopeSchema = { type: "string", enum: [...MEMORY_SCOPES] } as const;

/**
 * Metadata as every endpoint validates it: a JSON object whose serialization is
 * bounded. JSON Schema cannot bound serialized size, so the bound is an extension.
 */
export const metadataSchema = {
  type: "object",
  additionalProperties: true,
  "x-lore-maxSerializedLength": MEMORY_METADATA_LIMITS.maximumSerializedLength,
} as const;

export const timestampProperties = {
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

export const workspaceHeader = {
  name: "x-lore-workspace-id",
  in: "header",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

// The single Idempotency-Key rule (1-128 visible ASCII characters): the published
// OpenAPI header pattern and the runtime check in src/server/api/input.ts both use it.
export const IDEMPOTENCY_KEY_PATTERN = "^[\\x21-\\x7e]{1,128}$";

export const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", minLength: 1, maxLength: 128, pattern: IDEMPOTENCY_KEY_PATTERN },
} as const;

export const ifMatchHeader = {
  name: "If-Match",
  in: "header",
  required: true,
  schema: { type: "string", pattern: '^"memory-v[1-9][0-9]*"$' },
} as const;

export const memoryIdParameter = {
  name: "memoryId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

export const agentIdParameter = {
  name: "agentId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

export const humanSecurity = [
  { basicAuth: [] },
  { cloudflareAccessHeader: [] },
  { cloudflareAccessCookie: [] },
] as const;

export const actorSecurity = [{ agentBearer: [] }, ...humanSecurity] as const;

export function requestBody(schema: Record<string, unknown>) {
  return {
    required: true,
    content: { "application/json": { schema } },
  };
}

export function jsonResponse(description: string, schema: Record<string, unknown>, headers = {}) {
  return {
    description,
    headers,
    content: { "application/json": { schema } },
  };
}
