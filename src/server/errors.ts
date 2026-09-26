/**
 * The public error vocabulary: every `code` an API error response may carry. The
 * SDK, CLI, and MCP switch on these; `src/server/api/errors.ts` maps each to its
 * HTTP status, and the OpenAPI Error schema enumerates exactly this list.
 */
export const LORE_ERROR_CODES = [
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
] as const;
export type LoreErrorCode = (typeof LORE_ERROR_CODES)[number];

/**
 * A failure a caller may see, named by its public code. Its message is shown to the
 * caller; any other error is reported as `internal_error` without its message.
 * Domain modules declare the code, never a transport status.
 */
export abstract class DomainError extends Error {
  abstract readonly code: LoreErrorCode;
}
