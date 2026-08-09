import type { DeploymentCapabilities, ReadinessReport } from "./operations";
import type {
  ImportWorkspaceArchive,
  WorkspaceArchive,
  WorkspaceImportResult,
} from "./portability";
import { recordRequest } from "./request-log";
import type {
  AgentCredential,
  AgentGrantPermission,
  AgentWorkspaceGrant,
  GraphData,
  HumanActorSummary,
  IssuedAgentCredential,
  Memory,
  MemoryScope,
  MemorySearchResult,
  WorkspaceAgent,
  WorkspaceSummary,
} from "./types";

interface RequestOptions extends RequestInit {
  acceptedStatuses?: readonly number[];
  workspaceId?: string;
  operation: string;
}

async function requestJson<Result>(path: string, options: RequestOptions): Promise<Result> {
  const { acceptedStatuses = [], workspaceId, operation, ...init } = options;
  const startedAt = Date.now();
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (workspaceId) headers.set("x-lore-workspace-id", workspaceId);

  try {
    const response = await fetch(path, { ...init, headers });
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
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

export function listAgents(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceAgent[]> {
  return requestJson("/api/v1/agents", {
    workspaceId,
    operation: "GET /api/v1/agents",
    signal,
  });
}

export function getCurrentHumanActor(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<HumanActorSummary> {
  return requestJson("/api/v1/actor", {
    workspaceId,
    operation: "GET /api/v1/actor",
    signal,
  });
}

export function getDeploymentCapabilities(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<DeploymentCapabilities> {
  return requestJson("/api/v1/capabilities", {
    workspaceId,
    operation: "GET /api/v1/capabilities",
    signal,
  });
}

export function getReadiness(signal?: AbortSignal): Promise<ReadinessReport> {
  return requestJson("/readyz", {
    acceptedStatuses: [503],
    operation: "GET /readyz",
    signal,
  });
}

export function exportWorkspaceArchive(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceArchive> {
  return requestJson("/api/v1/workspaces/export", {
    workspaceId,
    operation: "GET /api/v1/workspaces/export",
    signal,
  });
}

export function importWorkspaceArchive(
  workspaceId: string,
  input: ImportWorkspaceArchive,
): Promise<WorkspaceImportResult> {
  return requestJson("/api/v1/workspaces/import", {
    method: "POST",
    body: JSON.stringify(input),
    workspaceId,
    operation: "POST /api/v1/workspaces/import",
  });
}

export function createAgent(
  workspaceId: string,
  input: { name: string; permission: AgentGrantPermission },
): Promise<WorkspaceAgent> {
  return requestJson("/api/v1/agents", {
    method: "POST",
    body: JSON.stringify(input),
    workspaceId,
    operation: "POST /api/v1/agents",
  });
}

export function updateAgent(
  workspaceId: string,
  agentId: string,
  input: { name?: string; status?: WorkspaceAgent["status"] },
): Promise<WorkspaceAgent> {
  return requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    workspaceId,
    operation: "PATCH /api/v1/agents/:id",
  });
}

export function deleteAgent(workspaceId: string, agentId: string): Promise<void> {
  return requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    workspaceId,
    operation: "DELETE /api/v1/agents/:id",
  });
}

export function listAgentCredentials(
  workspaceId: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<AgentCredential[]> {
  return requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}/credentials`, {
    workspaceId,
    operation: "GET /api/v1/agents/:id/credentials",
    signal,
  });
}

export function issueAgentCredential(
  workspaceId: string,
  agentId: string,
): Promise<IssuedAgentCredential> {
  return requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}/credentials`, {
    method: "POST",
    workspaceId,
    operation: "POST /api/v1/agents/:id/credentials",
  });
}

export function setAgentGrant(
  workspaceId: string,
  agentId: string,
  permission: AgentGrantPermission,
): Promise<AgentWorkspaceGrant> {
  return requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}/grant`, {
    method: "PUT",
    body: JSON.stringify({ permission }),
    workspaceId,
    operation: "PUT /api/v1/agents/:id/grant",
  });
}

export function revokeAgentGrant(workspaceId: string, agentId: string): Promise<void> {
  return requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}/grant`, {
    method: "DELETE",
    workspaceId,
    operation: "DELETE /api/v1/agents/:id/grant",
  });
}

export function revokeAgentCredential(workspaceId: string, credentialId: string): Promise<void> {
  return requestJson(`/api/v1/agent-credentials/${encodeURIComponent(credentialId)}`, {
    method: "DELETE",
    workspaceId,
    operation: "DELETE /api/v1/agent-credentials/:id",
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

export function readGraph(workspaceId: string, signal?: AbortSignal): Promise<GraphData> {
  return requestJson("/api/graph?limit=5000", {
    workspaceId,
    operation: "GET /api/graph",
    signal,
  });
}
