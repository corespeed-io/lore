/**
 * Shared parsing for the deployment environment every provider factory reads.
 * Each factory used to carry its own byte-identical copies of these three.
 */

/** A configured value, or `undefined` when the variable is unset or blank. */
export function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** A positive integer setting, falling back when the value is absent or invalid. */
export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Ollama's keep-alive: seconds as a number, or one of its duration strings such
 * as `5m`. An unset or empty value unloads the model after each request.
 */
export function keepAlive(value: string | undefined): string | number {
  if (value === undefined || value === "") return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}
