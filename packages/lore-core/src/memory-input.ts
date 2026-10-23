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

export const MEMORY_OCCURRED_AT_LIMITS = {
  /** The earliest and latest UTC years, so the RFC 3339 form keeps a four-digit year. */
  minimumYear: 1,
  maximumYear: 9999,
} as const;

/** An RFC 3339 date-time: date, `T`, time with seconds, optional fraction, and an offset. */
const RFC_3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * When the event or statement a Memory records happened, as its writer states it:
 * an RFC 3339 date-time with an offset, such as `2023-05-26T10:00:00Z` or
 * `2023-05-26T18:00:00+08:00`, whose instant falls in the UTC years 0001 through
 * 9999. Returns that instant as UTC (`Date.prototype.toISOString`), kept to the
 * millisecond. The engine never infers it from content and never moves a date
 * into range; the schema's memories_occurred_at_check restates the range.
 */
export function validateMemoryOccurredAt(value: unknown, field = "occurredAt"): string {
  const invalid = () =>
    new LoreValidationError(
      field,
      `${field} must be an RFC 3339 date-time with an offset, such as 2023-05-26T10:00:00Z`,
    );
  if (typeof value !== "string") throw invalid();
  const match = RFC_3339_DATE_TIME.exec(value);
  if (!match) throw invalid();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const offsetHours = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinutes = match[11] === undefined ? 0 : Number(match[11]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  ) {
    throw invalid();
  }
  const milliseconds = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"));
  // Date.UTC reads years 0 through 99 as 1900 through 1999, so set the year itself.
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, milliseconds);
  const offset = (offsetHours * 60 + offsetMinutes) * (match[9] === "-" ? -1 : 1);
  instant.setTime(instant.getTime() - offset * 60_000);
  const utcYear = instant.getUTCFullYear();
  if (
    utcYear < MEMORY_OCCURRED_AT_LIMITS.minimumYear ||
    utcYear > MEMORY_OCCURRED_AT_LIMITS.maximumYear
  ) {
    throw new LoreValidationError(
      field,
      `${field} must fall in the UTC years ${String(MEMORY_OCCURRED_AT_LIMITS.minimumYear).padStart(4, "0")} through ${MEMORY_OCCURRED_AT_LIMITS.maximumYear}`,
    );
  }
  return instant.toISOString();
}

/** A time to write, or null for none. */
export function validateOptionalMemoryOccurredAt(
  value: unknown,
  field = "occurredAt",
): string | null {
  return value === null ? null : validateMemoryOccurredAt(value, field);
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
