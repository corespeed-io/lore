import { recordRequest } from "./request-log";

interface RequestOptions extends RequestInit {
  acceptedStatuses?: readonly number[];
  workspaceId?: string;
  operation: string;
}

export async function requestJson<Result>(path: string, options: RequestOptions): Promise<Result> {
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
