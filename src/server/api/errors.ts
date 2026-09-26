import {
  LoreValidationError,
  MemoryAccessDeniedError,
  MemoryVersionConflictError,
} from "@corespeed/lore-core";
import { DomainError, type LoreErrorCode } from "@/server/errors";

/** The HTTP status of every public error code. */
const HTTP_STATUS: Record<LoreErrorCode, number> = {
  access_denied: 403,
  authentication_required: 401,
  idempotency_conflict: 409,
  internal_error: 500,
  invalid_archive: 400,
  invalid_request: 400,
  method_not_allowed: 405,
  not_found: 404,
  payload_too_large: 413,
  precondition_required: 428,
  proposal_capacity_exceeded: 409,
  proposal_review_conflict: 409,
  transaction_conflict: 409,
  version_conflict: 412,
  workspace_export_limit_exceeded: 409,
};

// The engine cannot extend OSS classes, so its public failures are named here.
const ENGINE_ERRORS = [
  [LoreValidationError, "invalid_request"],
  [MemoryAccessDeniedError, "access_denied"],
  [MemoryVersionConflictError, "version_conflict"],
] as const;

/** The public code of a failure a caller may see, or undefined for any other error. */
function publicCode(error: unknown): LoreErrorCode | undefined {
  if (error instanceof DomainError) return error.code;
  for (const [ErrorType, code] of ENGINE_ERRORS) {
    if (error instanceof ErrorType) return code;
  }
  return undefined;
}

// Deadlock and serialization failures roll the whole transaction back, so the
// request had no effect and the caller may safely retry it.
const RETRYABLE_TRANSACTION_SQLSTATES = new Set(["40001", "40P01"]);

function sqlState(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

export function errorResponse(error: unknown): Response {
  const code = publicCode(error);
  if (code && error instanceof Error) {
    // Only known domain failures may expose their message to callers.
    return Response.json(
      { code, error: error.message },
      { status: HTTP_STATUS[code], headers: { "cache-control": "private, no-store" } },
    );
  }
  const state = sqlState(error);
  if (RETRYABLE_TRANSACTION_SQLSTATES.has(String(state))) {
    return Response.json(
      {
        code: "transaction_conflict",
        error: "The request conflicted with a concurrent change; retry it",
      },
      { status: 409, headers: { "cache-control": "private, no-store", "retry-after": "1" } },
    );
  }
  // PostgreSQL enforces its text encoding restrictions for JSONB as well as text.
  if (state === "22P05" || state === "22021" || state === "22P02") {
    return Response.json(
      { code: "invalid_request", error: "Input contains an invalid text value" },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
  console.error("Unhandled Lore request error", error);
  return Response.json(
    { code: "internal_error", error: "Internal server error" },
    { status: 500, headers: { "cache-control": "private, no-store" } },
  );
}
