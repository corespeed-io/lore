import {
  LoreValidationError,
  MemoryAccessDeniedError,
  MemoryContentValidationError,
  MemoryVersionConflictError,
} from "@corespeed/lore-core";
import { expect, test, vi } from "vitest";
import {
  CodeEvidenceAccessDeniedError,
  CodeEvidenceValidationError,
} from "@/modules/code/evidence";
import {
  CodeIndexAccessDeniedError,
  CodeIndexValidationError,
} from "@/modules/code/indexing/errors";
import { ContextRetrievalValidationError } from "@/modules/context/retrieval";
import { EpisodeEvidenceAccessDeniedError } from "@/modules/episodes/evidence";
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
import { errorResponse } from "@/server/api/errors";
import { IdempotencyConflictError } from "@/server/api/idempotency";
import {
  BadRequestError,
  PayloadTooLargeError,
  PreconditionRequiredError,
} from "@/server/api/input";
import { AccessDeniedError, AgentNotDisabledError } from "@/server/auth/access";
import {
  RequestAuthenticationError,
  RequestInputError,
  WorkspaceAccessError,
} from "@/server/auth/request-context";

/**
 * Each public failure keeps the status and code it had when every error class
 * carried its own status: the refactor to one code-to-status table must not move
 * any of them, and a class that forgets to extend DomainError would fall to 500.
 */
test.each<[string, Error, number, string]>([
  ["BadRequestError", new BadRequestError("bad"), 400, "invalid_request"],
  ["RequestInputError", new RequestInputError("bad"), 400, "invalid_request"],
  ["LoreValidationError", new LoreValidationError("limit", "bad"), 400, "invalid_request"],
  ["MemoryContentValidationError", new MemoryContentValidationError("bad"), 400, "invalid_request"],
  ["CodeIndexValidationError", new CodeIndexValidationError("bad"), 400, "invalid_request"],
  ["CodeEvidenceValidationError", new CodeEvidenceValidationError("bad"), 400, "invalid_request"],
  [
    "ContextRetrievalValidationError",
    new ContextRetrievalValidationError("bad"),
    400,
    "invalid_request",
  ],
  ["PortabilityValidationError", new PortabilityValidationError("bad"), 400, "invalid_archive"],
  [
    "RequestAuthenticationError",
    new RequestAuthenticationError("who"),
    401,
    "authentication_required",
  ],
  ["WorkspaceAccessError", new WorkspaceAccessError("no"), 403, "access_denied"],
  ["AccessDeniedError", new AccessDeniedError("no"), 403, "access_denied"],
  ["MemoryAccessDeniedError", new MemoryAccessDeniedError("no"), 403, "access_denied"],
  [
    "MemoryProposalAccessDeniedError",
    new MemoryProposalAccessDeniedError("no"),
    403,
    "access_denied",
  ],
  ["ObservationAccessDeniedError", new ObservationAccessDeniedError("no"), 403, "access_denied"],
  [
    "EpisodeEvidenceAccessDeniedError",
    new EpisodeEvidenceAccessDeniedError("no"),
    403,
    "access_denied",
  ],
  ["CodeIndexAccessDeniedError", new CodeIndexAccessDeniedError("no"), 403, "access_denied"],
  ["CodeEvidenceAccessDeniedError", new CodeEvidenceAccessDeniedError("no"), 403, "access_denied"],
  ["PortabilityAccessDeniedError", new PortabilityAccessDeniedError("no"), 403, "access_denied"],
  ["EvaluationSuiteNotFoundError", new EvaluationSuiteNotFoundError("none"), 404, "not_found"],
  [
    "MemoryProposalCapacityError",
    new MemoryProposalCapacityError("full"),
    409,
    "proposal_capacity_exceeded",
  ],
  [
    "MemoryProposalReviewConflictError",
    new MemoryProposalReviewConflictError("stale"),
    409,
    "proposal_review_conflict",
  ],
  ["IdempotencyConflictError", new IdempotencyConflictError("reused"), 409, "idempotency_conflict"],
  [
    "WorkspaceExportLimitError",
    new WorkspaceExportLimitError("large"),
    409,
    "workspace_export_limit_exceeded",
  ],
  ["AgentNotDisabledError", new AgentNotDisabledError(), 409, "agent_not_disabled"],
  ["MemoryVersionConflictError", new MemoryVersionConflictError(1, 2), 412, "version_conflict"],
  ["PayloadTooLargeError", new PayloadTooLargeError("large"), 413, "payload_too_large"],
  [
    "PreconditionRequiredError",
    new PreconditionRequiredError("if-match"),
    428,
    "precondition_required",
  ],
])("%s keeps its public status and code", async (_name, error, status, code) => {
  const response = errorResponse(error);
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  // A public failure shows its own message and nothing else.
  await expect(response.json()).resolves.toEqual({ code, error: error.message });
});

test("an error that only looks public is reported as internal without its message", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    // A plain Error carrying a public-looking `code` property is not a DomainError.
    const lookalike = Object.assign(new Error("secret row detail"), { code: "not_found" });
    const response = errorResponse(lookalike);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "internal_error",
      error: "Internal server error",
    });
    // A bare TypeError is no longer an engine validation failure.
    expect(errorResponse(new TypeError("limit must be positive")).status).toBe(500);
  } finally {
    log.mockRestore();
  }
});
