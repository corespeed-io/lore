import {
  LoreValidationError,
  MEMORY_METADATA_LIMITS,
  MEMORY_SCOPES,
  type MemoryScope,
  validateMemoryMetadata,
} from "@corespeed/lore-core";
import { z } from "zod/v4";
import { parseMemoryInput } from "./input";

/**
 * Wire schemas for values several domains share: Memories, Proposals, Episodes, and
 * Workspace archives all carry a Memory scope and a JSON metadata object. Keeping
 * them here lets each domain validate them without importing another domain.
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

export function memoryScope(value: unknown): MemoryScope | undefined {
  return parseMemoryInput(MemoryScopeSchema.optional(), value);
}

export function metadata(value: unknown): Record<string, unknown> | undefined {
  return parseMemoryInput(MemoryMetadataSchema.optional(), value);
}
