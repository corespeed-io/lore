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

export const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", minLength: 1, maxLength: 128 },
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
