import { MEMORY_SCOPES, type MemoryScope } from "./memory-types";
import { boundedInteger, LoreValidationError } from "./validation";

export const MEMORY_METADATA_LIMITS = {
  /** `JSON.stringify` length of one metadata object, in UTF-16 code units. */
  maximumSerializedLength: 100_000,
} as const;

export const MEMORY_LIST_LIMITS = {
  defaultLimit: 50,
  maximumLimit: 100,
  maximumOffset: 1_000_000,
} as const;

export const MEMORY_SEARCH_LIMITS = {
  defaultLimit: 10,
  maximumLimit: 100,
  /** Trimmed query length, in UTF-16 code units. */
  maximumQueryLength: 10_000,
} as const;

export function validateMemoryScope(value: unknown, field = "scope"): MemoryScope {
  if (!MEMORY_SCOPES.includes(value as MemoryScope)) {
    throw new LoreValidationError(field, `${field} must be ${MEMORY_SCOPES.join(" or ")}`);
  }
  return value as MemoryScope;
}

/** A JSON object within the metadata bound; Memories, Links, and Observations share it. */
export function validateMemoryMetadata(
  value: unknown,
  field = "metadata",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LoreValidationError(field, `${field} must be an object`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new LoreValidationError(field, `${field} must be JSON serializable`, { cause: error });
  }
  if (serialized.length > MEMORY_METADATA_LIMITS.maximumSerializedLength) {
    throw new LoreValidationError(
      field,
      `${field} exceeds ${MEMORY_METADATA_LIMITS.maximumSerializedLength} characters`,
    );
  }
  return value as Record<string, unknown>;
}

export function memoryListLimit(value: number | undefined): number {
  return boundedInteger(value, "limit", {
    minimum: 1,
    maximum: MEMORY_LIST_LIMITS.maximumLimit,
    fallback: MEMORY_LIST_LIMITS.defaultLimit,
  });
}

export function memoryListOffset(value: number | undefined): number {
  return boundedInteger(value, "offset", {
    minimum: 0,
    maximum: MEMORY_LIST_LIMITS.maximumOffset,
    fallback: 0,
  });
}

export function memorySearchLimit(value: number | undefined): number {
  return boundedInteger(value, "limit", {
    minimum: 1,
    maximum: MEMORY_SEARCH_LIMITS.maximumLimit,
    fallback: MEMORY_SEARCH_LIMITS.defaultLimit,
  });
}

/** The trimmed search query; empty means no search. */
export function memorySearchQuery(value: string): string {
  if (typeof value !== "string") throw new LoreValidationError("query", "query must be a string");
  const query = value.trim();
  if (query.length > MEMORY_SEARCH_LIMITS.maximumQueryLength) {
    throw new LoreValidationError(
      "query",
      `query exceeds ${MEMORY_SEARCH_LIMITS.maximumQueryLength} characters`,
    );
  }
  return query;
}
