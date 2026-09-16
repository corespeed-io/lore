import {
  IdempotencyConflictError,
  MemoryAccessDeniedError,
  MemoryContentValidationError,
  MemoryVersionConflictError,
} from "@corespeed/lore-core";
import { ObservationAccessDeniedError } from "@corespeed/lore-core/episodes";
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
import { AccessDeniedError } from "@/server/auth/access";
import {
  RequestAuthenticationError,
  RequestInputError,
  WorkspaceAccessError,
} from "@/server/auth/request-context";
import { BadRequestError, PreconditionRequiredError } from "./input";

function errorCode(error: unknown): string {
  if (error instanceof PreconditionRequiredError) return "precondition_required";
  if (error instanceof MemoryVersionConflictError) return "version_conflict";
  if (error instanceof MemoryProposalCapacityError) return "proposal_capacity_exceeded";
  if (error instanceof MemoryProposalReviewConflictError) return "proposal_review_conflict";
  if (error instanceof IdempotencyConflictError) return "idempotency_conflict";
  if (error instanceof WorkspaceExportLimitError) return error.code;
  if (
    error instanceof BadRequestError ||
    error instanceof RequestInputError ||
    error instanceof MemoryContentValidationError
  )
    return "invalid_request";
  if (error instanceof RequestAuthenticationError) return "authentication_required";
  if (
    error instanceof WorkspaceAccessError ||
    error instanceof AccessDeniedError ||
    error instanceof MemoryAccessDeniedError ||
    error instanceof MemoryProposalAccessDeniedError ||
    error instanceof ObservationAccessDeniedError
  ) {
    return "access_denied";
  }
  if (error instanceof EvaluationSuiteNotFoundError) return "not_found";
  if (error instanceof PortabilityValidationError) return "invalid_archive";
  if (error instanceof PortabilityAccessDeniedError) return "access_denied";
  return "internal_error";
}

export function errorResponse(error: unknown): Response {
  if (
    error instanceof BadRequestError ||
    error instanceof RequestInputError ||
    error instanceof MemoryContentValidationError ||
    error instanceof RequestAuthenticationError ||
    error instanceof WorkspaceAccessError ||
    error instanceof PreconditionRequiredError ||
    error instanceof MemoryVersionConflictError ||
    error instanceof MemoryProposalCapacityError ||
    error instanceof MemoryProposalReviewConflictError ||
    error instanceof IdempotencyConflictError ||
    error instanceof PortabilityValidationError ||
    error instanceof PortabilityAccessDeniedError ||
    error instanceof WorkspaceExportLimitError
  ) {
    return Response.json(
      { code: errorCode(error), error: error.message },
      { status: error.status, headers: { "cache-control": "private, no-store" } },
    );
  }
  if (
    error instanceof AccessDeniedError ||
    error instanceof MemoryAccessDeniedError ||
    error instanceof MemoryProposalAccessDeniedError ||
    error instanceof ObservationAccessDeniedError
  ) {
    return Response.json(
      { code: errorCode(error), error: error.message },
      { status: 403, headers: { "cache-control": "private, no-store" } },
    );
  }
  if (error instanceof EvaluationSuiteNotFoundError) {
    return Response.json(
      { code: errorCode(error), error: error.message },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
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
