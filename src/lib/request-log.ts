// In-memory, per-browser-session log of the gbrain calls this tab has made via
// apiCall(). Read-only observability — it never leaves the browser, holds no
// credentials, and only records tool name + timing + outcome. Backs the
// dashboard's Connection health + Recent requests panels via useSyncExternalStore.

export interface RequestEntry {
  id: number;
  tool: string;
  at: number; // epoch ms when the call started
  latencyMs: number;
  ok: boolean;
  error?: string;
}

const MAX = 50;
let seq = 0;
let entries: RequestEntry[] = [];
const EMPTY: RequestEntry[] = []; // stable ref for the SSR snapshot
const listeners = new Set<() => void>();

export function recordRequest(e: Omit<RequestEntry, "id">): void {
  entries = [{ id: ++seq, ...e }, ...entries].slice(0, MAX);
  for (const l of listeners) l();
}

// Newest-first snapshot. Referentially stable until the next recordRequest,
// which is what useSyncExternalStore needs to avoid render loops.
export function getRequestLog(): RequestEntry[] {
  return entries;
}

export function getServerRequestLog(): RequestEntry[] {
  return EMPTY;
}

export function subscribeRequestLog(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Test helper — not used by the UI.
export function clearRequestLog(): void {
  entries = [];
  seq = 0;
}
