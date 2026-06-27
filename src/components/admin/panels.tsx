"use client";

import {
  type Agent,
  type CalibrationProfile,
  type LogEntry,
  type RequestsPage,
  type WatchSnapshot,
  agentCounts,
  agentOptions,
  dollars,
  formatParams,
  leasePressureColor,
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
  title: string;
  state: FetchState<unknown>;
  needs?: string;
  actions?: ReactNode;
  children: () => ReactNode;
}) {
  return (
    <section className="admin-section">
      <div className="admin-head">
        <h2 className="admin-h2">{title}</h2>
        {actions}
      </div>
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
  return (
    <Panel title="Admin dashboard" state={stats} needs="GET /admin/api/stats">
      {() => (
        <>
          <div className="admin-cards">
            {Object.entries(stats.data ?? {}).map(([k, v]) => (
              <div key={k} className="admin-card">
                <div className="admin-card-num">{String(v)}</div>
                <div className="admin-card-label">{k.replace(/_/g, " ")}</div>
              </div>
            ))}
            {Object.keys(stats.data ?? {}).length === 0 && (
              <p className="admin-muted">No summary metrics returned.</p>
            )}
          </div>
          {health.data && (
            <div className="admin-health">
              <p className="admin-card-label">Token health</p>
              {Object.entries(health.data).map(([k, v]) => (
                <div key={k} className="admin-health-row">
                  <span>{k.replace(/_/g, " ")}</span>
                  <span>{String(v)}</span>
                </div>
              ))}
            </div>
          )}
        </>
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
      title="Jobs watch"
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
                {s.top_errors.slice(0, 5).map((e) => (
                  <div key={e.message} className="admin-health-row">
                    <span className="admin-err-line">{e.message}</span>
                    <span>{e.count}</span>
                  </div>
                ))}
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

export function CalibrationPanel() {
  const cal = useAdmin<CalibrationProfile | null>("calibration");
  const p = cal.data;
  return (
    <Panel title="Calibration" state={cal} needs="GET /admin/api/calibration/profile">
      {() =>
        !p || !p.holder ? (
          <div className="admin-empty">
            <p className="admin-muted">
              No calibration profile yet. Builds after 5+ resolved takes.
            </p>
            <pre className="admin-pre">gbrain dream --phase calibration_profile</pre>
          </div>
        ) : (
          <>
            <p className="admin-muted">
              Holder: <b>{p.holder}</b>
              {p.updated_at ? ` · updated ${relativeTime(p.updated_at)}` : ""}
              {p.published ? " · published" : ""}
              {p.grade_completion < 0.9
                ? ` · ~${Math.round(p.grade_completion * 100)}% graded`
                : ""}
              {!p.voice_gate_passed ? " · voice gate fell back to template" : ""}
            </p>
            <div className="admin-charts">
              {CHARTS.map((c) => (
                <figure key={c.type} className="admin-chart">
                  {/* server-proxied SVG, chart-type allowlisted */}
                  <img src={`/api/admin/charts/${c.type}`} alt={c.label} loading="lazy" />
                  <figcaption>{c.label}</figcaption>
                </figure>
              ))}
            </div>
          </>
        )
      }
    </Panel>
  );
}

export function AgentsPanel() {
  const agents = useAdmin<Agent[]>("agents");
  const [hideRevoked, setHideRevoked] = useState(true);
  const [sel, setSel] = useState<Agent | null>(null);
  const all = Array.isArray(agents.data) ? agents.data : [];
  const { active, total } = agentCounts(all);
  const list = hideRevoked ? all.filter((a) => a.status !== "revoked") : all;
  return (
    <Panel
      title="Agents · clients · tokens"
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
      {() =>
        list.length === 0 ? (
          <p className="admin-muted">No agents.</p>
        ) : (
          <>
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
                  </tr>
                ))}
              </tbody>
            </table>
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
                    <dd>{sel.auth_type ?? "—"}</dd>
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
                  <p className="admin-needs">
                    Create key / register client / revoke / config-export are wired in the admin
                    proxy allowlist; their UI is deferred (see notes).
                  </p>
                </div>
              </div>
            )}
          </>
        )
      }
    </Panel>
  );
}
