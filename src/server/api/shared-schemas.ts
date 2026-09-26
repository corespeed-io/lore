import type { MemoryScope } from "@corespeed/lore-core";
import { z } from "zod/v4";
import { parseMemoryInput } from "./input";

/**
 * Wire schemas for values several domains share: Memories, Proposals, Episodes, and
 * Workspace archives all carry a Memory scope and a JSON metadata object. Keeping
 * them here lets each domain validate them without importing another domain.
 */
export const MemoryScopeSchema = z.enum(["shared", "private"], {
  error: "scope must be shared or private",
});

export const JsonValueSchema = z.json();

export const MemoryMetadataSchema = z
  .record(z.string(), JsonValueSchema, { error: "metadata must be an object" })
  .refine((value) => JSON.stringify(value).length <= 100_000, {
    error: "metadata exceeds 100000 characters",
  });

export function memoryScope(value: unknown): MemoryScope | undefined {
  return parseMemoryInput(MemoryScopeSchema.optional(), value);
}

export function metadata(value: unknown): Record<string, unknown> | undefined {
  return parseMemoryInput(MemoryMetadataSchema.optional(), value);
}
