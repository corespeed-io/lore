import { BadRequestError, parseMemoryInput } from "@/server/api/input";
import { metadata } from "@/server/api/shared-schemas";
import { CreateMemoryInputSchema } from "./schemas";

export function memoryEtag(version: number): string {
  return `"memory-v${version}"`;
}

export function requiredMemoryContent(value: unknown): string {
  return parseMemoryInput(CreateMemoryInputSchema.shape.content, value);
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
