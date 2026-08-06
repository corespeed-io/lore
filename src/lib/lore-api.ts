import { recordRequest } from "./request-log";
import type { GraphData, Memory, MemoryScope, MemorySearchResult, WorkspaceSummary } from "./types";

interface RequestOptions extends RequestInit {
  workspaceId?: string;
  operation: string;
}

async function requestJson<Result>(path: string, options: RequestOptions): Promise<Result> {
  const { workspaceId, operation, ...init } = options;
  const startedAt = Date.now();
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (workspaceId) headers.set("x-lore-workspace-id", workspaceId);

  try {
    const response = await fetch(path, { ...init, headers });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error ?? `Request failed (${response.status})`);
    }
    recordRequest({
      operation,
      at: startedAt,
      latencyMs: Date.now() - startedAt,
      ok: true,
    });
    if (response.status === 204) return undefined as Result;
    return response.json() as Promise<Result>;
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    const error = cause instanceof Error ? cause.message : String(cause);
    recordRequest({
      operation,
      at: startedAt,
      latencyMs: Date.now() - startedAt,
      ok: false,
      error,
    });
    throw cause;
  }
}

function compact(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

export function memoryTitle(memory: Memory): string {
  const configured = memory.metadata.title;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const firstLine = memory.content.split(/\r?\n/, 1)[0] ?? memory.content;
  return compact(firstLine.replace(/^#+\s*/, ""), 96) || "Untitled memory";
}

export function memoryType(memory: Memory): string {
  const configured = memory.metadata.type;
  return typeof configured === "string" && configured.trim() ? configured.trim() : memory.scope;
}

export function listWorkspaces(signal?: AbortSignal): Promise<WorkspaceSummary[]> {
  return requestJson("/api/workspaces", {
    operation: "GET /api/workspaces",
    signal,
  });
}

export async function createWorkspace(name: string): Promise<WorkspaceSummary> {
  const workspace = await requestJson<Omit<WorkspaceSummary, "role">>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
    operation: "POST /api/workspaces",
  });
  return { ...workspace, role: "owner" };
}

export function listMemories(
  workspaceId: string,
  input: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<Memory[]> {
  const params = new URLSearchParams({
    limit: String(input.limit ?? 100),
    offset: String(input.offset ?? 0),
  });
  return requestJson(`/api/memories?${params}`, {
    workspaceId,
    operation: "GET /api/memories",
    signal: input.signal,
  });
}

export async function listAllMemories(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<Memory[]> {
  const pageSize = 100;
  const cap = 20_000;
  const memories: Memory[] = [];
  for (let offset = 0; offset < cap; offset += pageSize) {
    const batch = await listMemories(workspaceId, { limit: pageSize, offset, signal });
    memories.push(...batch);
    if (batch.length < pageSize) break;
  }
  return memories;
}

export function searchMemories(
  workspaceId: string,
  query: string,
  limit = 25,
  signal?: AbortSignal,
): Promise<MemorySearchResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
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
    workspaceId,
    operation: "POST /api/memories",
  });
}

export function updateMemory(
  workspaceId: string,
  id: string,
  input: { content?: string; scope?: MemoryScope; metadata?: Record<string, unknown> },
): Promise<Memory> {
  return requestJson(`/api/memories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    workspaceId,
    operation: "PATCH /api/memories/:id",
  });
}

export function forgetMemory(workspaceId: string, id: string): Promise<void> {
  return requestJson(`/api/memories/${encodeURIComponent(id)}`, {
    method: "DELETE",
    workspaceId,
    operation: "DELETE /api/memories/:id",
  });
}

export function readGraph(workspaceId: string, signal?: AbortSignal): Promise<GraphData> {
  return requestJson("/api/graph?limit=5000", {
    workspaceId,
    operation: "GET /api/graph",
    signal,
  });
}
