import {
  LoreValidationError,
  MEMORY_GLOSS_LIMITS,
  MEMORY_METADATA_LIMITS,
  MEMORY_SCOPES,
  MEMORY_TITLE_LIMITS,
  type MemoryScope,
  validateMemoryGloss,
  validateMemoryMetadata,
  validateMemoryOccurredAt,
  validateMemoryTitle,
} from "@corespeed/lore-core";
import { z } from "zod/v4";
import { parseMemoryInput } from "./input";

/**
 * Wire schemas for values several domains share: Memories, Proposals, Episodes, and
 * Workspace archives all carry a Memory scope and a JSON metadata object, and all but
 * Episodes a Memory title, gloss, and occurredAt. Keeping them here lets each domain
 * validate them without importing another domain.
 */
export const MemoryScopeSchema = z.enum(MEMORY_SCOPES, {
  error: `scope must be ${MEMORY_SCOPES.join(" or ")}`,
});

export const JsonValueSchema = z.json();

// Zod checks the JSON shape; the engine owns the metadata rule itself.
export const MemoryMetadataSchema = z
  .record(z.string(), JsonValueSchema, { error: "metadata must be an object" })
  .superRefine((value, context) => {
    try {
      validateMemoryMetadata(value);
    } catch (error) {
      if (!(error instanceof LoreValidationError)) throw error;
      context.addIssue({ code: "custom", message: error.message });
    }
  })
  // JSON Schema cannot bound an object's serialized size, so publish the rule.
  .meta({ "x-lore-maxSerializedLength": MEMORY_METADATA_LIMITS.maximumSerializedLength });

// Zod checks the type; the engine owns the title rule. JSON Schema maxLength counts
// code points, as the rule does, where a Zod length would count UTF-16 units.
export const MemoryTitleSchema = z
  .string({ error: "title must be a string" })
  .superRefine((value, context) => {
    try {
      validateMemoryTitle(value);
    } catch (error) {
      if (!(error instanceof LoreValidationError)) throw error;
      context.addIssue({ code: "custom", message: error.message });
    }
  })
  .meta({ minLength: 1, maxLength: MEMORY_TITLE_LIMITS.maximumCharacters });

// HTTP trims a title, as it trims content; engine writes keep their exact text. Null
// means no title, and on an update removes it.
export const MemoryTitleInputSchema = z
  .string({ error: "title must be a string" })
  .trim()
  .pipe(MemoryTitleSchema)
  .nullable();

// A gloss is an English rendering of content in another language, for English keyword
// search. The engine owns its rule, as it owns the title's.
export const MemoryGlossSchema = z
  .string({ error: "gloss must be a string" })
  .superRefine((value, context) => {
    try {
      validateMemoryGloss(value);
    } catch (error) {
      if (!(error instanceof LoreValidationError)) throw error;
      context.addIssue({ code: "custom", message: error.message });
    }
  })
  .meta({ minLength: 1, maxLength: MEMORY_GLOSS_LIMITS.maximumCharacters });

export const MemoryGlossInputSchema = z
  .string({ error: "gloss must be a string" })
  .trim()
  .pipe(MemoryGlossSchema)
  .nullable();

// When the event or statement a Memory records happened, as its writer states it: an
// RFC 3339 date-time with an offset. The engine owns the rule and keeps the UTC
// instant, so HTTP passes the writer's text through. Null means none, and on an
// update removes it.
export const MemoryOccurredAtInputSchema = z
  .string({ error: "occurredAt must be a string" })
  .superRefine((value, context) => {
    try {
      validateMemoryOccurredAt(value);
    } catch (error) {
      if (!(error instanceof LoreValidationError)) throw error;
      context.addIssue({ code: "custom", message: error.message });
    }
  })
  .meta({ format: "date-time" })
  .nullable();

export function memoryScope(value: unknown): MemoryScope | undefined {
  return parseMemoryInput(MemoryScopeSchema.optional(), value);
}

export function memoryTitle(value: unknown): string | null | undefined {
  return parseMemoryInput(MemoryTitleInputSchema.optional(), value);
}

export function memoryGloss(value: unknown): string | null | undefined {
  return parseMemoryInput(MemoryGlossInputSchema.optional(), value);
}

export function memoryOccurredAt(value: unknown): string | null | undefined {
  return parseMemoryInput(MemoryOccurredAtInputSchema.optional(), value);
}

export function metadata(value: unknown): Record<string, unknown> | undefined {
  return parseMemoryInput(MemoryMetadataSchema.optional(), value);
}
