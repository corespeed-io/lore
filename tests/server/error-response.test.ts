import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LoreConfigurationError,
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
  MemoryProposalValidationError,
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
import { MethodNotAllowedError, NotFoundError } from "@/server/errors";

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
  [
    "MemoryProposalValidationError",
    new MemoryProposalValidationError("evidence", "bad"),
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
  ["NotFoundError", new NotFoundError("none"), 404, "not_found"],
  ["MethodNotAllowedError", new MethodNotAllowedError("no"), 405, "method_not_allowed"],
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
    // A bad deployment option is the operator's failure, not the caller's.
    expect(
      errorResponse(new LoreConfigurationError("rerankWeight", "rerankWeight is out of range"))
        .status,
    ).toBe(500);
  } finally {
    log.mockRestore();
  }
});

// A 4xx/5xx status literal handed to c.json/c.body/c.text, or a `code` key in any
// `json({ ... })` object literal.
const PUBLIC_ERROR_BODY =
  /\bc\.(?:json|body|text)\((?:[^;]|\n)*?,\s*[45]\d\d\s*[,)]|json\(\s*\{[^}]*\bcode\s*:/;

test("the public-error-body guard catches reordered and code-less bodies", () => {
  for (const source of [
    'c.json({ error: "Agent not found", code: "not_found" }, 404)',
    'c.json({ error: "gone" }, 404)',
    "c.body(null, 404)",
    'Response.json({ code: "not_found", error: "gone" })',
  ]) {
    expect(PUBLIC_ERROR_BODY.test(source), source).toBe(true);
  }
  for (const source of ["c.json(result, 201)", "c.body(null, 204)", "c.json(memory)"]) {
    expect(PUBLIC_ERROR_BODY.test(source), source).toBe(false);
  }
});

test("no route writes a public error body itself", () => {
  // A literal `json({ code: ... })` body would pair a code with a status the one
  // table does not own; everything else throws a DomainError or calls errorResponse.
  const offenders: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        /\.tsx?$/.test(entry.name) &&
        path !== join("src", "server", "api", "errors.ts") &&
        PUBLIC_ERROR_BODY.test(readFileSync(path, "utf8"))
      ) {
        offenders.push(path);
      }
    }
  };
  visit("src");
  expect(offenders).toEqual([]);
});
