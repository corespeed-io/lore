import type { MemoryScope } from "@corespeed/lore-core";
import { BadRequestError, parseMemoryInput } from "@/server/http/input";
import { CreateMemoryInputSchema, MemoryMetadataSchema, MemoryScopeSchema } from "./schemas";

export function requiredMemoryContent(value: unknown): string {
  return parseMemoryInput(CreateMemoryInputSchema.shape.content, value);
}

export function memoryScope(value: unknown): MemoryScope | undefined {
  return parseMemoryInput(MemoryScopeSchema.optional(), value);
}

export function metadata(value: unknown): Record<string, unknown> | undefined {
  return parseMemoryInput(MemoryMetadataSchema.optional(), value);
}

export function metadataFilter(value: string | null): Record<string, unknown> | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value.length > 10_000) throw new BadRequestError("metadata exceeds 10000 characters");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BadRequestError("metadata must be valid JSON");
  }
  return metadata(parsed);
}
