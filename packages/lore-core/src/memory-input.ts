import { MEMORY_SCOPES, type MemoryScope } from "./memory-types";
import {
  boundedInteger,
  hasLoneSurrogate,
  isStorableText,
  LoreValidationError,
} from "./validation";

export const MEMORY_TITLE_LIMITS = {
  /** Unicode characters (code points), as PostgreSQL's char_length counts them. */
  maximumCharacters: 256,
} as const;

export const MEMORY_GLOSS_LIMITS = {
  /** Unicode characters (code points), as PostgreSQL's char_length counts them. */
  maximumCharacters: 512,
} as const;

/**
 * A control character (C0, DEL, C1) or a line or paragraph separator. A title or
 * gloss is one line, so it holds none; all of them are single UTF-16 units.
 */
function isLineControl(unit: number): boolean {
  return unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f) || unit === 0x2028 || unit === 0x2029;
}

/** The whitespace `String.prototype.trim` removes that a line may still hold. */
const LINE_SPACES = new Set([
  0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

/**
 * One line of 1 to `maximum` characters, at least one of them not whitespace, with
 * no control character or line break, stored as written and never trimmed.
 */
function validateLine(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new LoreValidationError(field, `${field} must be a string`);
  // A code point takes one or two UTF-16 units, so the unit length bounds the count.
  let tooLong = value.length > maximum * 2;
  if (!tooLong && value.length > maximum) {
    let count = 0;
    for (const _codePoint of value) count += 1;
    tooLong = count > maximum;
  }
  if (tooLong) {
    throw new LoreValidationError(field, `${field} may contain at most ${maximum} characters`);
  }
  let visible = false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (isLineControl(unit)) {
      throw new LoreValidationError(field, `${field} must be one line without control characters`);
    }
    if (!LINE_SPACES.has(unit)) visible = true;
  }
  if (hasLoneSurrogate(value)) {
    throw new LoreValidationError(field, `${field} contains invalid Unicode`);
  }
  if (!visible) {
    throw new LoreValidationError(
      field,
      `${field} must contain a character that is not whitespace`,
    );
  }
  return value;
}

/**
 * A Memory title: one line of 1 to 256 characters (`validateLine`). The schema's
 * memories_title_check restates this rule.
 */
export function validateMemoryTitle(value: unknown, field = "title"): string {
  return validateLine(value, field, MEMORY_TITLE_LIMITS.maximumCharacters);
}

/** A title to write, or null for none. */
export function validateOptionalMemoryTitle(value: unknown, field = "title"): string | null {
  return value === null ? null : validateMemoryTitle(value, field);
}

/**
 * A Memory gloss: an English rendering of a Memory written in another language, so
 * English keyword search finds it. One line of 1 to 512 characters (`validateLine`);
 * the engine cannot tell its language, and the schema's memories_gloss_check
 * restates the rest.
 */
export function validateMemoryGloss(value: unknown, field = "gloss"): string {
  return validateLine(value, field, MEMORY_GLOSS_LIMITS.maximumCharacters);
}

/** A gloss to write, or null for none. */
export function validateOptionalMemoryGloss(value: unknown, field = "gloss"): string | null {
  return value === null ? null : validateMemoryGloss(value, field);
}

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
  /** Translations of one query: the same question in other languages. */
  maximumTranslations: 3,
} as const;

export function validateMemoryScope(value: unknown, field = "scope"): MemoryScope {
  if (!MEMORY_SCOPES.includes(value as MemoryScope)) {
    throw new LoreValidationError(field, `${field} must be ${MEMORY_SCOPES.join(" or ")}`);
  }
  return value as MemoryScope;
}

/**
 * A JSON object within the metadata bound whose keys and strings PostgreSQL can
 * store; Memories, Links, Observations, and filters share it.
 */
export function validateMemoryMetadata(
  value: unknown,
  field = "metadata",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LoreValidationError(field, `${field} must be an object`);
  }
  let serialized: string;
  let storable = true;
  try {
    serialized = JSON.stringify(value, (key: string, item: unknown) => {
      if (!isStorableText(key) || (typeof item === "string" && !isStorableText(item))) {
        storable = false;
      }
      return item;
    });
  } catch (error) {
    throw new LoreValidationError(field, `${field} must be JSON serializable`, { cause: error });
  }
  if (!storable) {
    throw new LoreValidationError(field, `${field} contains a NUL character or invalid Unicode`);
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

/**
 * The trimmed translations of a search query: the same question in other languages,
 * which search runs beside the query so it also matches Memories written in them.
 * Each obeys the query's bound and must say something; none means an empty list.
 */
export function memorySearchTranslations(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new LoreValidationError("translations", "translations must be an array of strings");
  }
  if (value.length > MEMORY_SEARCH_LIMITS.maximumTranslations) {
    throw new LoreValidationError(
      "translations",
      `translations may hold at most ${MEMORY_SEARCH_LIMITS.maximumTranslations} queries`,
    );
  }
  return value.map((item: unknown) => {
    if (typeof item !== "string") {
      throw new LoreValidationError("translations", "translations must be an array of strings");
    }
    const translation = item.trim();
    if (!translation) {
      throw new LoreValidationError("translations", "a translation must not be empty");
    }
    if (translation.length > MEMORY_SEARCH_LIMITS.maximumQueryLength) {
      throw new LoreValidationError(
        "translations",
        `a translation exceeds ${MEMORY_SEARCH_LIMITS.maximumQueryLength} characters`,
      );
    }
    return translation;
  });
}
