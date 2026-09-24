// Generated from Lore's canonical OpenAPI document. Do not edit by hand.
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
  "workspace_export_limit_exceeded"
] as const;

export const MEMORY_CONTENT_LIMITS = {
  "recommendedCharacters": 8000,
  "maximumCharacters": 32000
} as const;
