export const errorSchema = {
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
        "method_not_allowed",
        "not_found",
        "payload_too_large",
        "precondition_required",
        "proposal_capacity_exceeded",
        "proposal_review_conflict",
        "transaction_conflict",
        "version_conflict",
        "workspace_export_limit_exceeded",
      ],
    },
    error: { type: "string" },
  },
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
