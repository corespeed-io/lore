/**
 * Every rule the engine enforces on its inputs throws LoreValidationError, so a
 * host maps this one class to its invalid-input response instead of restating the
 * rules. Subclasses keep a narrower name for callers that branch on them.
 */
export class LoreValidationError extends TypeError {
  override name = "LoreValidationError";
  /** The input that failed, for example `content` or `observations[2].metadata`. */
  readonly field: string;

  constructor(field: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.field = field;
  }
}

/** Whether `value` contains an unpaired UTF-16 surrogate, which PostgreSQL refuses. */
export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      // charCodeAt past the end is NaN and every NaN comparison is false, so a
      // string ENDING in a high surrogate needs the integer guard to be caught.
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Text PostgreSQL can store in `text` and JSONB: no NUL and no unpaired surrogate. */
export function isStorableText(value: string): boolean {
  return !value.includes("\0") && !hasLoneSurrogate(value);
}

/** A finite number from `minimum` through `maximum`, or `fallback` when omitted. */
export function boundedNumber(
  value: number | undefined,
  field: string,
  bounds: { minimum: number; maximum: number; fallback: number },
): number {
  if (value === undefined) return bounds.fallback;
  if (!Number.isFinite(value) || value < bounds.minimum || value > bounds.maximum) {
    throw new LoreValidationError(
      field,
      `${field} must be a number from ${bounds.minimum} through ${bounds.maximum}`,
    );
  }
  return value;
}

/** An integer from `minimum` through `maximum`, or `fallback` when omitted. */
export function boundedInteger(
  value: number | undefined,
  field: string,
  bounds: { minimum: number; maximum: number; fallback: number },
): number {
  if (value === undefined) return bounds.fallback;
  if (!Number.isInteger(value) || value < bounds.minimum || value > bounds.maximum) {
    throw new LoreValidationError(
      field,
      `${field} must be an integer from ${bounds.minimum} through ${bounds.maximum}`,
    );
  }
  return value;
}
