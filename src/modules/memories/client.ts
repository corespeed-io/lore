import type {
  CreateMemoryInput,
  Memory,
  MemoryScope,
  UpdateMemoryInput,
} from "@corespeed/lore-sdk";
import { getBrowserClient } from "@/shared/browser/sdk";
import type { MemorySearchResult } from "./types";

export async function listMemories(
  workspaceId: string,
  input: {
    limit?: number;
    metadataFilter?: Record<string, unknown>;
    offset?: number;
    scope?: MemoryScope;
    updatedAfter?: string;
    updatedBefore?: string;
    signal?: AbortSignal;
  } = {},
): Promise<Memory[]> {
  const { metadataFilter, ...filters } = input;
  const page = await getBrowserClient()
    .workspace(workspaceId)
    .listMemories({
      ...filters,
      limit: input.limit ?? 100,
      offset: input.offset ?? 0,
      metadata: metadataFilter,
    });
  return [...page.memories];
}

export async function searchMemories(
  workspaceId: string,
  query: string,
  limit = 25,
  signal?: AbortSignal,
  filters: {
    metadataFilter?: Record<string, unknown>;
    scope?: MemoryScope;
    updatedAfter?: string;
    updatedBefore?: string;
  } = {},
): Promise<MemorySearchResult[]> {
  const { metadataFilter, ...rest } = filters;
  return [
    ...(await getBrowserClient()
      .workspace(workspaceId)
      .searchMemories({
        ...rest,
        query,
        limit,
        signal,
        metadata: metadataFilter,
      })),
  ];
}

export function getMemory(workspaceId: string, id: string, signal?: AbortSignal): Promise<Memory> {
  return getBrowserClient().workspace(workspaceId).getMemory(id, signal);
}

export function rememberMemory(workspaceId: string, input: CreateMemoryInput): Promise<Memory> {
  return getBrowserClient().workspace(workspaceId).remember(input);
}

export function updateMemory(
  workspaceId: string,
  id: string,
  input: UpdateMemoryInput,
  expectedVersion: number,
): Promise<Memory> {
  return getBrowserClient().workspace(workspaceId).updateMemory(id, input, { expectedVersion });
}

export function forgetMemory(
  workspaceId: string,
  id: string,
  expectedVersion: number,
): Promise<void> {
  return getBrowserClient().workspace(workspaceId).forgetMemory(id, { expectedVersion });
}
