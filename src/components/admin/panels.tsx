"use client";

import {
  type Agent,
  type CalibrationProfile,
  type LogEntry,
  type RequestsPage,
  type WatchSnapshot,
  agentCounts,
  agentOptions,
  calibrationGeneratedAt,
  calibrationIssues,
  decimal,
  dollars,
  formatParams,
  leasePressureColor,
  percent,
  relativeTime,
  scopeList,
} from "@/lib/admin-format";
import { type ReactNode, useCallback, useEffect, useState } from "react";

// gbrain admin/observability surfaces in the unified Lore console. Everything
// reads through /api/admin/*, which fails closed (403) unless admin mode is
// configured server-side. No credentials reach the client; responses are
// secret-stripped. Shapes mirror upstream garrytan/gbrain admin/src/pages.

type FetchState<T> = { loading: boolean; data: T | null; error: string | null; status: number };

async function adminGet<T>(action: string, qs = "") {
  try {
    const r = await fetch(`/api/admin/${action}${qs}`);
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { detail?: string };
      return { data: null as T | null, status: r.status, error: body.detail ?? `HTTP ${r.status}` };
    }
    return { data: (await r.json()) as T, status: 200, error: null as string | null };
  } catch (e) {
    return { data: null as T | null, status: 0, error: e instanceof Error ? e.message : "error" };
  }
}

async function adminPost<T>(action: string, args: Record<string, unknown>) {
  try {
    const r = await fetch(`/api/admin/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { detail?: string };
      return { data: null as T | null, status: r.status, error: body.detail ?? `HTTP ${r.status}` };
    }
    return { data: (await r.json()) as T, status: 200, error: null as string | null };
  } catch (e) {
    return { data: null as T | null, status: 0, error: e instanceof Error ? e.message : "error" };
  }
}

function useAdmin<T>(
  action: string,
  qs = "",
  pollMs?: number,
): FetchState<T> & { reload: () => void } {
  const [s, setS] = useState<FetchState<T>>({ loading: true, data: null, error: null, status: 0 });
  const reload = useCallback(() => {
    adminGet<T>(action, qs).then((r) => setS({ loading: false, ...r }));
  }, [action, qs]);
  useEffect(() => {
    reload();
    if (!pollMs) return;
    const id = setInterval(reload, pollMs);
    return () => clearInterval(id);
  }, [reload, pollMs]);
  return { ...s, reload };
}

function Panel({
  title,
  state,
  needs,
  actions,
  children,
}: {
  title?: string;
  state: FetchState<unknown>;
  needs?: string;
  actions?: ReactNode;
  children: () => ReactNode;
}) {
  return (
    <section className="admin-section">
      {(title || actions) && (
        <div className="admin-head">
          {title && <h2 className="admin-h2">{title}</h2>}
          {actions}
        </div>
      )}
      {state.loading && !state.data ? (
        <p className="admin-muted">Loading…</p>
      ) : state.status === 403 ? (
        <p className="admin-muted">
          Admin mode is disabled. Set <code>ADMIN_MODE</code>, <code>ADMIN_GBRAIN_URL</code> and{" "}
          <code>ADMIN_GBRAIN_TOKEN</code> on the server to enable it.
        </p>
      ) : state.error ? (
        <div className="admin-empty">
          <p className="admin-muted">Couldn't load: {state.error}</p>
          {needs && (
            <p className="admin-needs">
              Requires the gbrain backend to expose <code>{needs}</code>.
            </p>
          )}
        </div>
      ) : (
        children()
      )}
    </section>
  );
}

export function AdminDashboard() {
  const stats = useAdmin<Record<string, number>>("stats");
  const health = useAdmin<Record<string, number | string>>("health");
  const metrics = [...Object.entries(stats.data ?? {}), ...Object.entries(health.data ?? {})];
  return (
    <Panel state={stats} needs="GET /admin/api/stats">
      {() => (
        <div className="admin-overview-card">
          <p className="admin-card-label">Operations</p>
          <div className="admin-mini-grid">
            {metrics.map(([k, v]) => (
              <div key={k} className="admin-mini-metric">
                <span>{k.replace(/_/g, " ")}</span>
                <strong>{String(v)}</strong>
              </div>
            ))}
            {metrics.length === 0 && <p className="admin-muted">No summary metrics returned.</p>}
          </div>
          {health.loading && !health.data && <p className="admin-muted">Loading token health…</p>}
        </div>
      )}
    </Panel>
  );
}

function LogRow({ r }: { r: LogEntry }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(r.params || r.error_message);
  return (
    <>
      <tr>
        <td className="admin-x-cell">
          {expandable && (
            <button type="button" className="admin-expand" onClick={() => setOpen(!open)}>
              {open ? "▾" : "▸"}
            </button>
          )}
        </td>
        <td>{relativeTime(r.created_at)}</td>
        <td>{r.agent_name || r.token_name}</td>
        <td className="admin-mono">{r.operation}</td>
        <td className="admin-muted-cell">{formatParams(r.params) ?? "—"}</td>
        <td>{r.latency_ms != null ? `${r.latency_ms}ms` : "—"}</td>
        <td>
          <span className={r.error_message ? "req-status-err" : "req-status-ok"}>
            {r.status || (r.error_message ? "error" : "ok")}
          </span>
        </td>
      </tr>
      {open && (
        <tr className="admin-row-detail">
          <td colSpan={7}>
            {r.params && <pre className="admin-pre">{JSON.stringify(r.params, null, 2)}</pre>}
            {r.error_message && <p className="admin-err-line">Error: {r.error_message}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

export function RequestLogPanel() {
  const [page, setPage] = useState(1);
  const [agent, setAgent] = useState("all");
  const qs = `?page=${page}${agent !== "all" ? `&agent=${encodeURIComponent(agent)}` : ""}`;
  const reqs = useAdmin<RequestsPage>("requests", qs);
  const d = reqs.data;
  const rows = d?.rows ?? [];
  const opts = agentOptions(rows);
  return (
    <Panel
      title="Request log"
      state={reqs}
      needs="GET /admin/api/requests?page=N → { rows, total, page, pages }"
      actions={
        <select
          className="admin-select"
          value={agent}
          onChange={(e) => {
            setAgent(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">All agents</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      }
    >
      {() =>
        rows.length === 0 ? (
          <p className="admin-muted">No requests recorded for this filter.</p>
        ) : (
          <>
            <table className="admin-table">
              <thead>
                <tr>
                  <th aria-label="expand" />
                  <th>Time</th>
                  <th>Agent</th>
                  <th>Operation</th>
                  <th>Params</th>
                  <th>Latency</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <LogRow key={r.id} r={r} />
                ))}
              </tbody>
            </table>
            <div className="admin-pager">
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                ← Prev
              </button>
              <span>
                Page {d?.page ?? page} of {d?.pages ?? 1} ({d?.total ?? rows.length} total)
              </span>
              <button
                type="button"
                disabled={(d?.page ?? page) >= (d?.pages ?? 1)}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </button>
            </div>
          </>
        )
      }
    </Panel>
  );
}

export function JobsPanel() {
  const jobs = useAdmin<WatchSnapshot>("jobs", "", 2000);
  const s = jobs.data;
  return (
    <Panel
      title="Queue"
      state={jobs}
      needs="GET /admin/api/jobs/watch"
      actions={
        <button type="button" className="admin-btn" onClick={jobs.reload}>
          Refresh
        </button>
      }
    >
      {() =>
        !s ? (
          <p className="admin-muted">No snapshot.</p>
        ) : (
          <div className="admin-jobs">
            <div className="admin-jobs-queue">
              <span className="admin-card-label">Queue</span>
              <b>waiting {s.queue_health?.waiting ?? 0}</b>
              <b>active {s.queue_health?.active ?? 0}</b>
              <b style={{ color: (s.queue_health?.stalled ?? 0) > 0 ? "#d29922" : undefined }}>
                stalled {s.queue_health?.stalled ?? 0}
              </b>
            </div>
            {(s.by_type?.length ?? 0) > 0 && (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Total</th>
                    <th>Completed</th>
                    <th>Failed</th>
                    <th>Dead</th>
                  </tr>
                </thead>
                <tbody>
                  {s.by_type.slice(0, 8).map((t) => (
                    <tr key={t.name}>
                      <td className="admin-mono">{t.name}</td>
                      <td>{t.total}</td>
                      <td>{t.completed}</td>
                      <td>{t.failed}</td>
                      <td>{t.dead}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="admin-kv">
              <p className="admin-card-label">Lease pressure (1h)</p>
              <span style={{ color: leasePressureColor(s.lease_pressure_1h ?? 0) }}>
                {s.lease_pressure_1h ?? 0} bounce{s.lease_pressure_1h === 1 ? "" : "s"}
              </span>
            </div>
            {(s.top_errors?.length ?? 0) > 0 && (
              <div className="admin-kv">
                <p className="admin-card-label">Top errors</p>
                {s.top_errors.slice(0, 5).map((e) => {
                  const label = e.cluster ?? e.message ?? "unknown error";
                  return (
                    <div key={label} className="admin-health-row">
                      <span className="admin-err-line">{label}</span>
                      <span>{e.count}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {(s.budget_owners?.length ?? 0) > 0 && (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Budget owner</th>
                    <th>Spent</th>
                    <th>Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {s.budget_owners.slice(0, 5).map((b) => (
                    <tr key={b.owner_id}>
                      <td>#{b.owner_id}</td>
                      <td>{dollars(b.total_spent_cents)}</td>
                      <td>{dollars(b.remaining_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <details className="admin-details">
              <summary>Raw snapshot</summary>
              <pre className="admin-pre">{JSON.stringify(s, null, 2)}</pre>
            </details>
          </div>
        )
      }
    </Panel>
  );
}

const CHARTS = [
  { type: "brier-trend", label: "Brier trend" },
  { type: "pattern-statements", label: "Pattern statements" },
  { type: "domain-bars", label: "Per-domain accuracy" },
  { type: "abandoned-threads", label: "Abandoned threads" },
];

function CalibrationMetric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="calibration-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function CalibrationGate({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="calibration-gate">
      <span className={ok ? "calibration-dot-ok" : "calibration-dot-warn"} />
      <div>
        <b>{label}</b>
        <small>{value}</small>
      </div>
    </div>
  );
}

export function CalibrationPanel() {
  const cal = useAdmin<CalibrationProfile | null>("calibration");
  const p = cal.data;
  const generated = p ? calibrationGeneratedAt(p) : undefined;
  const issues = p ? calibrationIssues(p) : [];
  const patterns = p?.pattern_statements ?? [];
  const biasTags = p?.active_bias_tags ?? [];
  return (
    <Panel
      title="Calibration"
      state={cal}
      needs="GET /admin/api/calibration/profile"
      actions={
        <button type="button" className="admin-btn" onClick={cal.reload}>
          Refresh
        </button>
      }
    >
      {() =>
        !p || !p.holder ? (
          <div className="calibration-shell">
            <div className="calibration-hero-panel">
              <div>
                <p className="admin-card-label">Profile status</p>
                <h3>Cold start</h3>
                <p>
                  Build the first profile after the brain has at least five resolved takes for the
                  holder.
                </p>
              </div>
              <span className="calibration-pill calibration-pill-warn">No profile</span>
            </div>
            <div className="calibration-grid">
              <div className="calibration-card">
                <p className="admin-card-label">Data gate</p>
                <strong>5+ resolved takes</strong>
                <span>
                  Resolved takes are the scored hindsight examples calibration learns from.
                </span>
              </div>
              <div className="calibration-card">
                <p className="admin-card-label">Run on gbrain host</p>
                <code>gbrain calibration --regenerate</code>
                <span>
                  Equivalent phase: <code>gbrain dream --phase calibration_profile</code>
                </span>
              </div>
              <div className="calibration-card">
                <p className="admin-card-label">Fallback loop</p>
                <code>gbrain dream --phase propose_takes,grade_takes,calibration_profile</code>
                <span>Use this when no takes have been proposed or graded yet.</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="calibration-shell">
            <div className="calibration-hero-panel">
              <div>
                <p className="admin-card-label">Calibration profile</p>
                <h3>{p.holder}</h3>
                <p>
                  {generated ? `Generated ${relativeTime(generated)}` : "Generated time unknown"}
                  {p.source_id ? ` · source ${p.source_id}` : ""}
                  {p.model_id ? ` · ${p.model_id}` : ""}
                </p>
              </div>
              <span
                className={`calibration-pill ${
                  p.published ? "calibration-pill-ok" : "calibration-pill-neutral"
                }`}
              >
                {p.published ? "Published" : "Private"}
              </span>
            </div>
            <div className="calibration-metrics">
              <CalibrationMetric
                label="Resolved takes"
                value={p.total_resolved != null ? String(p.total_resolved) : "—"}
                note="profile sample"
              />
              <CalibrationMetric label="Brier" value={decimal(p.brier)} note="lower is better" />
              <CalibrationMetric label="Accuracy" value={percent(p.accuracy, 1)} />
              <CalibrationMetric label="Partial" value={percent(p.partial_rate, 1)} />
              <CalibrationMetric label="Coverage" value={percent(p.grade_completion)} />
            </div>
            <div className="calibration-grid calibration-grid-two">
              <div className="calibration-card">
                <p className="admin-card-label">Quality gates</p>
                <CalibrationGate
                  label="Data threshold"
                  value={`${p.total_resolved ?? 0} resolved takes`}
                  ok={(p.total_resolved ?? 0) >= 5}
                />
                <CalibrationGate
                  label="Grade coverage"
                  value={`${percent(p.grade_completion)} graded`}
                  ok={p.grade_completion >= 0.9}
                />
                <CalibrationGate
                  label="Voice gate"
                  value={
                    p.voice_gate_passed
                      ? `${p.voice_gate_attempts} attempt${p.voice_gate_attempts === 1 ? "" : "s"}`
                      : `template fallback after ${p.voice_gate_attempts} attempt${
                          p.voice_gate_attempts === 1 ? "" : "s"
                        }`
                  }
                  ok={p.voice_gate_passed}
                />
                {issues.length > 0 && (
                  <div className="calibration-issues">
                    {issues.map((issue) => (
                      <span key={issue.key}>
                        {issue.label}: {issue.detail}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="calibration-card">
                <p className="admin-card-label">Active bias tags</p>
                {biasTags.length > 0 ? (
                  <div className="calibration-chip-row">
                    {biasTags.map((tag) => (
                      <span key={tag} className="calibration-chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="admin-muted">No active tags on this profile.</p>
                )}
              </div>
            </div>
            <div className="calibration-card">
              <p className="admin-card-label">Pattern statements</p>
              {patterns.length > 0 ? (
                <ol className="calibration-patterns">
                  {patterns.map((statement, index) => (
                    <li key={`${index}-${statement}`}>{statement}</li>
                  ))}
                </ol>
              ) : (
                <p className="admin-muted">No pattern statements returned.</p>
              )}
            </div>
            <div className="admin-charts">
              {CHARTS.map((c) => (
                <figure key={c.type} className="admin-chart">
                  {/* server-proxied SVG, chart-type allowlisted */}
                  <img src={`/api/admin/charts/${c.type}`} alt={c.label} loading="lazy" />
                  <figcaption>{c.label}</figcaption>
                </figure>
              ))}
            </div>
            <details className="admin-details">
              <summary>Raw profile</summary>
              <pre className="admin-pre">{JSON.stringify(p, null, 2)}</pre>
            </details>
          </div>
        )
      }
    </Panel>
  );
}

export function AgentsPanel() {
  const agents = useAdmin<Agent[]>("agents");
  const [hideRevoked, setHideRevoked] = useState(true);
  const [sel, setSel] = useState<Agent | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<{ id: string; name: string; token: string } | null>(
    null,
  );
  const [mutation, setMutation] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const all = Array.isArray(agents.data) ? agents.data : [];
  const { active, total } = agentCounts(all);
  const list = hideRevoked ? all.filter((a) => a.status !== "revoked") : all;
  const isMutating = mutation !== null;

  async function createApiKey(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = newKeyName.trim();
    if (!name) return;
    setMutation("create");
    setMutationError(null);
    setCopied(false);
    const r = await adminPost<{ id: string; name: string; token: string }>("create-api-key", {
      name,
    });
    setMutation(null);
    if (r.error || !r.data) {
      setMutationError(r.error ?? "Couldn't create API key");
      return;
    }
    setCreatedKey(r.data);
    setNewKeyName("");
    agents.reload();
  }

  async function revokeApiKey(agent: Agent) {
    if (agent.auth_type !== "api_key" || agent.status === "revoked") return;
    if (!window.confirm(`Revoke API key "${agent.name}"? Existing clients using it will fail.`))
      return;
    setMutation(`revoke:${agent.name}`);
    setMutationError(null);
    const r = await adminPost<{ revoked: boolean }>("revoke-api-key", { name: agent.name });
    setMutation(null);
    if (r.error) {
      setMutationError(r.error);
      return;
    }
    if (sel?.name === agent.name) setSel(null);
    agents.reload();
  }

  async function copyCreatedKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard?.writeText(createdKey.token);
      setCopied(true);
    } catch {
      setMutationError("Couldn't copy API key. Select the token and copy it manually.");
    }
  }

  return (
    <Panel
      title="Access"
      state={agents}
      needs="GET /admin/api/agents"
      actions={
        <label className="admin-toggle">
          <input
            type="checkbox"
            checked={hideRevoked}
            onChange={(e) => setHideRevoked(e.target.checked)}
          />{" "}
          Hide revoked{" "}
          <span className="admin-count">
            {active} active / {total} total
          </span>
        </label>
      }
    >
      {() => (
        <>
          <p className="admin-muted">
            OAuth clients and API keys that can read or write this brain.
          </p>
          <form className="admin-inline-form" onSubmit={createApiKey}>
            <input
              className="admin-input"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="New API key name"
              autoComplete="off"
            />
            <button
              type="submit"
              className="admin-btn"
              disabled={isMutating || newKeyName.trim().length === 0}
            >
              {mutation === "create" ? "Creating..." : "+ API key"}
            </button>
          </form>
          {mutationError && <p className="admin-error-note">{mutationError}</p>}
          {createdKey && (
            <div className="admin-secret-card" aria-live="polite">
              <div>
                <p className="admin-card-label">One-time API key</p>
                <p className="admin-muted">Save this token now. gbrain will not show it again.</p>
              </div>
              <code>{createdKey.token}</code>
              <div className="admin-secret-actions">
                <button type="button" className="admin-btn" onClick={copyCreatedKey}>
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  className="admin-btn admin-btn-ghost"
                  onClick={() => setCreatedKey(null)}
                >
                  Done
                </button>
              </div>
            </div>
          )}
          {list.length === 0 ? (
            <p className="admin-muted">No clients or keys yet — create one above.</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Scopes</th>
                  <th>Status</th>
                  <th>Today</th>
                  <th>Total</th>
                  <th>Last used</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <button type="button" className="admin-link-btn" onClick={() => setSel(a)}>
                        {a.name}
                      </button>
                    </td>
                    <td>
                      <span className="admin-badge">
                        {a.auth_type === "api_key" ? "API key" : "OAuth"}
                      </span>
                    </td>
                    <td>
                      {scopeList(a.scope).map((sc) => (
                        <span key={sc} className="admin-scope">
                          {sc}
                        </span>
                      ))}
                    </td>
                    <td>
                      <span className={a.status === "revoked" ? "req-status-err" : "req-status-ok"}>
                        {a.status ?? "active"}
                      </span>
                    </td>
                    <td>{a.requests_today ?? "—"}</td>
                    <td>{a.total_requests ?? "—"}</td>
                    <td>{relativeTime(a.last_used_at)}</td>
                    <td>
                      {a.auth_type === "api_key" ? (
                        <button
                          type="button"
                          className="admin-danger-btn"
                          disabled={a.status === "revoked" || mutation === `revoke:${a.name}`}
                          onClick={() => revokeApiKey(a)}
                        >
                          {mutation === `revoke:${a.name}` ? "Revoking..." : "Revoke"}
                        </button>
                      ) : (
                        <span className="admin-muted-cell">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {sel && (
            <div className="admin-drawer">
              <button
                type="button"
                className="admin-drawer-scrim"
                aria-label="Close"
                onClick={() => setSel(null)}
              />
              <div className="admin-drawer-body">
                <button type="button" className="admin-drawer-close" onClick={() => setSel(null)}>
                  ×
                </button>
                <h3>{sel.name}</h3>
                <dl className="admin-dl">
                  <dt>id</dt>
                  <dd className="admin-mono">{sel.id}</dd>
                  <dt>type</dt>
                  <dd>{sel.auth_type === "api_key" ? "API key" : "OAuth client"}</dd>
                  <dt>scopes</dt>
                  <dd>{scopeList(sel.scope).join(", ") || "—"}</dd>
                  <dt>status</dt>
                  <dd>{sel.status ?? "active"}</dd>
                  <dt>token ttl</dt>
                  <dd>{sel.token_ttl ?? "default"}</dd>
                  <dt>requests today</dt>
                  <dd>{sel.requests_today ?? 0}</dd>
                  <dt>total requests</dt>
                  <dd>{sel.total_requests ?? 0}</dd>
                  <dt>last used</dt>
                  <dd>{relativeTime(sel.last_used_at)}</dd>
                </dl>
                {sel.auth_type === "api_key" && (
                  <div className="admin-drawer-actions">
                    <button
                      type="button"
                      className="admin-danger-btn"
                      disabled={sel.status === "revoked" || mutation === `revoke:${sel.name}`}
                      onClick={() => revokeApiKey(sel)}
                    >
                      {mutation === `revoke:${sel.name}` ? "Revoking..." : "Revoke API key"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
