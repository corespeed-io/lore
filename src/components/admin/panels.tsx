"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";

// gbrain admin/observability surfaces, rendered as tabs inside the unified Lore
// console. Every panel reads through /api/admin/*, which fails closed (403)
// unless admin mode is configured server-side — so on the public OSS default
// these panels show a clear "admin disabled" state. No credentials reach the
// client; a create's one-time secret would be shown once and masked.
// Tables follow upstream gbrain admin (garrytan/gbrain admin/src/pages).

type FetchState<T> = { loading: boolean; data: T | null; error: string | null; status: number };

async function adminGet<T>(
  action: string,
  qs = "",
): Promise<{ data: T | null; status: number; error: string | null }> {
  try {
    const r = await fetch(`/api/admin/${action}${qs}`);
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { detail?: string };
      return { data: null, status: r.status, error: body.detail ?? `HTTP ${r.status}` };
    }
    return { data: (await r.json()) as T, status: 200, error: null };
  } catch (e) {
    return { data: null, status: 0, error: e instanceof Error ? e.message : "network error" };
  }
}

function useAdmin<T>(action: string, qs = ""): FetchState<T> & { reload: () => void } {
  const [s, setS] = useState<FetchState<T>>({ loading: true, data: null, error: null, status: 0 });
  const reload = useCallback(() => {
    setS((p) => ({ ...p, loading: true }));
    adminGet<T>(action, qs).then(({ data, status, error }) =>
      setS({ loading: false, data, error, status }),
    );
  }, [action, qs]);
  useEffect(() => reload(), [reload]);
  return { ...s, reload };
}

// Shared loading / disabled / error / empty frame.
function Panel({
  title,
  state,
  needs,
  children,
}: {
  title: string;
  state: FetchState<unknown>;
  needs?: string;
  children: () => ReactNode;
}) {
  return (
    <section className="admin-section">
      <h2 className="admin-h2">{title}</h2>
      {state.loading ? (
        <p className="admin-muted">Loading…</p>
      ) : state.status === 403 ? (
        <p className="admin-muted">
          Admin mode is disabled. Configure <code>ADMIN_MODE</code>, <code>ADMIN_GBRAIN_URL</code>{" "}
          and <code>ADMIN_GBRAIN_TOKEN</code> on the server to enable it.
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

interface Agent {
  name?: string;
  type?: string;
  scopes?: string[];
  status?: string;
  requests?: number;
  last_used?: string;
}

export function AgentsPanel() {
  const agents = useAdmin<Agent[]>("agents");
  const list = Array.isArray(agents.data) ? agents.data : [];
  return (
    <Panel title="Agents · clients · tokens" state={agents} needs="GET /admin/api/agents">
      {() =>
        list.length === 0 ? (
          <p className="admin-muted">No agents reported by the backend.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Scopes</th>
                <th>Status</th>
                <th>Requests</th>
                <th>Last used</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: agent rows have no stable id; name may repeat
                <tr key={`${a.name ?? "agent"}-${i}`}>
                  <td>{a.name ?? "—"}</td>
                  <td>{a.type ?? "—"}</td>
                  <td>{(a.scopes ?? []).join(", ") || "—"}</td>
                  <td>{a.status ?? "—"}</td>
                  <td>{a.requests ?? "—"}</td>
                  <td>{a.last_used ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    </Panel>
  );
}

interface ReqRow {
  time?: string;
  agent?: string;
  operation?: string;
  params?: string;
  latency_ms?: number;
  status?: string;
}

export function RequestLogPanel() {
  const [page, setPage] = useState(1);
  const reqs = useAdmin<{ items?: ReqRow[] }>("requests", `?page=${page}`);
  const items = reqs.data?.items ?? (Array.isArray(reqs.data) ? (reqs.data as ReqRow[]) : []);
  return (
    <Panel title="Request log" state={reqs} needs="GET /admin/api/requests?page=N">
      {() => (
        <>
          {items.length === 0 ? (
            <p className="admin-muted">No requests on this page.</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Agent</th>
                  <th>Operation</th>
                  <th>Params</th>
                  <th>Latency</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: log rows have no stable id
                  <tr key={`${r.time ?? ""}-${r.operation ?? ""}-${i}`}>
                    <td>{r.time ?? "—"}</td>
                    <td>{r.agent ?? "—"}</td>
                    <td className="admin-mono">{r.operation ?? "—"}</td>
                    <td>{r.params ?? "—"}</td>
                    <td>{r.latency_ms != null ? `${r.latency_ms}ms` : "—"}</td>
                    <td>{r.status ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="admin-pager">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Prev
            </button>
            <span>Page {page}</span>
            <button
              type="button"
              disabled={items.length === 0}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}

export function JobsPanel() {
  const jobs = useAdmin<{ queue?: Record<string, number> }>("jobs");
  return (
    <Panel title="Jobs watch" state={jobs} needs="GET /admin/api/jobs/watch">
      {() => (
        <div className="admin-kv">
          <p className="admin-card-label">Queue snapshot</p>
          <pre className="admin-pre">
            {JSON.stringify(jobs.data?.queue ?? jobs.data ?? {}, null, 2)}
          </pre>
        </div>
      )}
    </Panel>
  );
}

export function CalibrationPanel() {
  const cal = useAdmin<{ profile?: unknown } | null>("calibration");
  const hasProfile = cal.data && (cal.data as { profile?: unknown }).profile;
  return (
    <Panel title="Calibration" state={cal} needs="GET /admin/api/calibration/profile">
      {() =>
        hasProfile ? (
          <pre className="admin-pre">{JSON.stringify(cal.data, null, 2)}</pre>
        ) : (
          <div className="admin-empty">
            <p className="admin-muted">
              No calibration profile yet. Builds after 5+ resolved takes.
            </p>
            <pre className="admin-pre">gbrain dream --phase calibration_profile</pre>
          </div>
        )
      }
    </Panel>
  );
}
