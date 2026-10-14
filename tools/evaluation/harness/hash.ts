import { createHash } from "node:crypto";

/**
 * The harness's hashes, in a file of their own: the ingest path imports them,
 * so anything else here would make every edit to it seed new corpora.
 */
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A stable hash of a JSON value; object keys are sorted so key order never matters. */
export function identityHash(value: unknown): string {
  return sha256(JSON.stringify(sortKeys(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}
