// Pure formatting/normalization for the admin console — no React/DOM deps, so
// upstream-shape handling is unit-testable against fixtures. Shapes mirror
// upstream garrytan/gbrain admin/src/pages.

export interface LogEntry {
  id: number;
  token_name: string;
  agent_name: string;
  operation: string;
  latency_ms: number;
  status: string;
  params: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
}
export interface RequestsPage {
  rows: LogEntry[];
  total: number;
  page: number;
  pages: number;
}

export interface Agent {
  id: string;
  name: string;
  auth_type?: string; // "oauth" | "api_key"
  scope?: string; // space/comma-separated
  status?: string; // "active" | "revoked"
  requests_today?: number;
  total_requests?: number;
  last_used_at?: string | null;
  token_ttl?: number | null;
  grant_types?: string[];
}

export interface WatchSnapshot {
  queue_health: { waiting: number; active: number; stalled: number };
  by_type: Array<{ name: string; total: number; completed: number; failed: number; dead: number }>;
  lease_pressure_1h: number;
  top_errors: Array<{ message: string; count: number }>;
  budget_owners: Array<{ owner_id: number; remaining_cents: number; total_spent_cents: number }>;
}

export interface CalibrationProfile {
  holder: string;
  updated_at?: string;
  published: boolean;
  brier: number | null;
  grade_completion: number;
  pattern_statements: string[];
  voice_gate_passed: boolean;
  voice_gate_attempts: number;
}

// "just now" / "5m ago" / "3h ago" / "2d ago".
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Compact params summary — matches upstream RequestLog.formatParams.
export function formatParams(params: Record<string, unknown> | null): string | null {
  if (!params) return null;
  const { query, slug, partial, limit, ...rest } = params as Record<string, unknown>;
  const parts: string[] = [];
  if (query) parts.push(`"${String(query)}"`);
  if (slug) parts.push(String(slug));
  if (partial) parts.push(`~${String(partial)}`);
  if (limit) parts.push(`limit=${String(limit)}`);
  const extra = Object.keys(rest).length;
  if (extra > 0) parts.push(`+${extra} params`);
  return parts.join(" · ") || null;
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function leasePressureColor(bounces: number): string {
  if (bounces <= 0) return "var(--muted)";
  if (bounces < 5) return "#d29922"; // warn
  return "#e5484d"; // critical
}

// Request Log agent filter options: value = token_name, label = agent_name.
export function agentOptions(rows: LogEntry[]): { value: string; label: string }[] {
  const m = new Map<string, string>();
  for (const r of rows) if (r.token_name) m.set(r.token_name, r.agent_name || r.token_name);
  return [...m.entries()].map(([value, label]) => ({ value, label }));
}

export function agentCounts(agents: Agent[]): { active: number; total: number } {
  return { total: agents.length, active: agents.filter((a) => a.status !== "revoked").length };
}

export function scopeList(scope: string | undefined): string[] {
  return (scope ?? "").split(/[\s,]+/).filter(Boolean);
}
