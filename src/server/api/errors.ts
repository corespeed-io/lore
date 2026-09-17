import {
  MemoryAccessDeniedError,
  MemoryContentValidationError,
  MemoryVersionConflictError,
} from "@corespeed/lore-core";
import {
  CodeEvidenceAccessDeniedError,
  CodeEvidenceValidationError,
} from "@/modules/code/evidence";
import {
  CodeIndexAccessDeniedError,
  CodeIndexValidationError,
} from "@/modules/code/indexing/errors";
import { ContextRetrievalValidationError } from "@/modules/context/retrieval";
import { ObservationAccessDeniedError } from "@/modules/episodes/service";
import { EvaluationSuiteNotFoundError } from "@/modules/evaluations/service";
import {
  PortabilityAccessDeniedError,
  PortabilityValidationError,
  WorkspaceExportLimitError,
} from "@/modules/portability/service";
import {
  MemoryProposalAccessDeniedError,
  MemoryProposalCapacityError,
  MemoryProposalReviewConflictError,
} from "@/modules/proposals/service";
import { IdempotencyConflictError } from "@/server/api/idempotency";
import { AccessDeniedError } from "@/server/auth/access";
import {
  RequestAuthenticationError,
  RequestInputError,
  WorkspaceAccessError,
} from "@/server/auth/request-context";
import { BadRequestError, PreconditionRequiredError } from "./input";

// Only known domain failures may expose their message to callers.
const errorResponses = [
  [BadRequestError, 400, "invalid_request"],
  [RequestInputError, 400, "invalid_request"],
  [MemoryContentValidationError, 400, "invalid_request"],
  [CodeIndexValidationError, 400, "invalid_request"],
  [CodeEvidenceValidationError, 400, "invalid_request"],
  [ContextRetrievalValidationError, 400, "invalid_request"],
  [RequestAuthenticationError, 401, "authentication_required"],
  [WorkspaceAccessError, 403, "access_denied"],
  [AccessDeniedError, 403, "access_denied"],
  [MemoryAccessDeniedError, 403, "access_denied"],
  [MemoryProposalAccessDeniedError, 403, "access_denied"],
  [ObservationAccessDeniedError, 403, "access_denied"],
  [CodeIndexAccessDeniedError, 403, "access_denied"],
  [CodeEvidenceAccessDeniedError, 403, "access_denied"],
  [PortabilityAccessDeniedError, 403, "access_denied"],
  [EvaluationSuiteNotFoundError, 404, "not_found"],
  [MemoryProposalCapacityError, 409, "proposal_capacity_exceeded"],
  [MemoryProposalReviewConflictError, 409, "proposal_review_conflict"],
  [IdempotencyConflictError, 409, "idempotency_conflict"],
  [WorkspaceExportLimitError, 409, "workspace_export_limit_exceeded"],
  [MemoryVersionConflictError, 412, "version_conflict"],
  [PreconditionRequiredError, 428, "precondition_required"],
  [PortabilityValidationError, 400, "invalid_archive"],
] as const;

export function errorResponse(error: unknown): Response {
  for (const [ErrorType, status, code] of errorResponses) {
    if (error instanceof ErrorType) {
      return Response.json(
        { code, error: error.message },
        { status, headers: { "cache-control": "private, no-store" } },
      );
    }
  }
  // PostgreSQL enforces its text encoding restrictions for JSONB as well as text.
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "22P05" || error.code === "22021" || error.code === "22P02")
  ) {
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
