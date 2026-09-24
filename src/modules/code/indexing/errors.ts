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
 * A Code Index job failed for a reason a later attempt can outlive, so it keeps
 * its retry budget and backoff instead of ending dead on the first attempt. The
 * message is always a fixed, content-free string: the job persists it as
 * `last_error`, where Workspace readers see it.
 */
export class CodeIndexRetryableError extends Error {
  override name = "CodeIndexRetryableError";
}

/**
 * Git could not read the revision yet: a spawn or open hit resource exhaustion,
 * the process was killed, the repository path does not resolve (a mount that is
 * not up yet), or the commit is not in the local clone (not fetched yet).
 */
export class GitOperationalError extends CodeIndexRetryableError {
  override name = "GitOperationalError";
}

/**
 * The worker's own LORE_CODE_REPOSITORIES does not serve the job's repository key
 * to the job's Workspace. During a rolling registry update, or with workers whose
 * registries differ, another attempt (possibly on another worker) can succeed.
 */
export class CodeRepositoryUnavailableError extends CodeIndexRetryableError {
  override name = "CodeRepositoryUnavailableError";
}
