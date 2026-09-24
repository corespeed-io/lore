export class CodeIndexAccessDeniedError extends Error {
  override name = "CodeIndexAccessDeniedError";
  readonly status = 403;
}

export class CodeIndexValidationError extends Error {
  override name = "CodeIndexValidationError";
  readonly status = 400;
}

export class CodeRevisionConflictError extends Error {
  override name = "CodeRevisionConflictError";
  readonly status = 409;
}

/**
 * Git could not run for an operational reason a later attempt can outlive: a
 * spawn or open hit resource exhaustion, or the process was killed. It is not a
 * validation failure, so a maintenance job keeps its retry budget instead of
 * ending dead on the first attempt.
 */
export class GitOperationalError extends Error {
  override name = "GitOperationalError";
}
