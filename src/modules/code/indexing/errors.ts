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
