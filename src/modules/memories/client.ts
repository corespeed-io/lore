import { requestJson } from "@/shared/browser/http";
import type { Memory, MemoryScope } from "./schemas";
import type { MemorySearchResult } from "./types";

export function listMemories(
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
  const params = new URLSearchParams({
    limit: String(input.limit ?? 100),
    offset: String(input.offset ?? 0),
  });
  if (input.scope) params.set("scope", input.scope);
  if (input.metadataFilter) params.set("metadata", JSON.stringify(input.metadataFilter));
  if (input.updatedAfter) params.set("updated_after", input.updatedAfter);
  if (input.updatedBefore) params.set("updated_before", input.updatedBefore);
  return requestJson(`/api/memories?${params}`, {
    workspaceId,
    operation: "GET /api/memories",
    signal: input.signal,
  });
}

export function searchMemories(
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
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (filters.metadataFilter) params.set("metadata", JSON.stringify(filters.metadataFilter));
  if (filters.scope) params.set("scope", filters.scope);
  if (filters.updatedAfter) params.set("updated_after", filters.updatedAfter);
  if (filters.updatedBefore) params.set("updated_before", filters.updatedBefore);
  return requestJson<MemorySearchResult[]>(`/api/memories?${params}`, {
    workspaceId,
    operation: "GET /api/memories?q",
    signal,
  });
}

export function getMemory(workspaceId: string, id: string, signal?: AbortSignal): Promise<Memory> {
  return requestJson(`/api/memories/${encodeURIComponent(id)}`, {
    workspaceId,
    operation: "GET /api/memories/:id",
    signal,
  });
}

export function rememberMemory(
  workspaceId: string,
  input: { content: string; scope: MemoryScope; metadata?: Record<string, unknown> },
): Promise<Memory> {
  return requestJson("/api/memories", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "idempotency-key": crypto.randomUUID() },
    workspaceId,
    operation: "POST /api/memories",
  });
}

export function updateMemory(
  workspaceId: string,
  id: string,
  input: { content?: string; scope?: MemoryScope; metadata?: Record<string, unknown> },
  expectedVersion: number,
): Promise<Memory> {
  return requestJson(`/api/memories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    headers: {
      "idempotency-key": crypto.randomUUID(),
      "if-match": `"memory-v${expectedVersion}"`,
    },
    workspaceId,
    operation: "PATCH /api/memories/:id",
  });
}

export function forgetMemory(
  workspaceId: string,
  id: string,
  expectedVersion: number,
): Promise<void> {
  return requestJson(`/api/memories/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: {
      "idempotency-key": crypto.randomUUID(),
      "if-match": `"memory-v${expectedVersion}"`,
    },
    workspaceId,
    operation: "DELETE /api/memories/:id",
  });
}
