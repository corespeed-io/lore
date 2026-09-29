/**
 * The public error vocabulary: every `code` an API error response may carry. The
 * SDK, CLI, and MCP switch on these; `HTTP_STATUS` below maps each to its HTTP
 * status, `src/server/api/errors.ts` answers with it, and the OpenAPI Error schema
 * enumerates exactly this list.
 */
export const LORE_ERROR_CODES = [
  "access_denied",
  "agent_not_disabled",
  "authentication_required",
  "idempotency_conflict",
  "internal_error",
  "invalid_archive",
  "invalid_request",
  "memory_link_capacity_exceeded",
  "method_not_allowed",
  "not_found",
  "payload_too_large",
  "precondition_required",
  "proposal_capacity_exceeded",
  "proposal_review_conflict",
  "transaction_conflict",
  "version_conflict",
  "workspace_export_limit_exceeded",
] as const;
export type LoreErrorCode = (typeof LORE_ERROR_CODES)[number];

/**
 * The HTTP status of every public error code, in one table. It imports nothing, so
 * the Edge-runtime admission path (src/server/auth/auth.ts) reads it too.
 */
export const HTTP_STATUS: Readonly<Record<LoreErrorCode, number>> = Object.freeze({
  access_denied: 403,
  agent_not_disabled: 409,
  authentication_required: 401,
  idempotency_conflict: 409,
  internal_error: 500,
  invalid_archive: 400,
  invalid_request: 400,
  memory_link_capacity_exceeded: 409,
  method_not_allowed: 405,
  not_found: 404,
  payload_too_large: 413,
  precondition_required: 428,
  proposal_capacity_exceeded: 409,
  proposal_review_conflict: 409,
  transaction_conflict: 409,
  version_conflict: 412,
  workspace_export_limit_exceeded: 409,
});

/**
 * A failure a caller may see, named by its public code. Its message is shown to the
 * caller; any other error is reported as `internal_error` without its message.
 * Domain modules declare the code, never a transport status.
 */
export abstract class DomainError extends Error {
  abstract readonly code: LoreErrorCode;
}

/** A resource the caller named does not exist or is not visible to it. */
export class NotFoundError extends DomainError {
  override name = "NotFoundError";
  readonly code = "not_found";
}

/** The route exists, but not for this method. */
export class MethodNotAllowedError extends DomainError {
  override name = "MethodNotAllowedError";
  readonly code = "method_not_allowed";
}

/** The Actor may not perform this operation. */
export class AccessDeniedError extends DomainError {
  override name = "AccessDeniedError";
  readonly code = "access_denied";
}
