"use client";

import { useSyncExternalStore } from "react";
import { getRequestLog, getServerRequestLog, subscribeRequestLog } from "@/lib/request-log";

function clock(at: number): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour12: false });
}

// The native Lore API calls this browser session has made — time, route, latency, status,
// and the error when one occurred. Read-only and session-scoped: it shows only
// THIS tab's own requests (not all agents, which would need admin scope).
export function RecentRequests() {
  const log = useSyncExternalStore(subscribeRequestLog, getRequestLog, getServerRequestLog);

  return (
    <div className="panel-card">
      <p className="panel-card-title">Recent requests · this session</p>
      {log.length === 0 ? (
        <p className="panel-empty">
          No API calls yet — browse the graph or search to see them here.
        </p>
      ) : (
        <div className="req-list">
          {log.map((e) => (
            <div key={e.id} className={`req-row${e.ok ? "" : " req-row-err"}`}>
              <span className="req-time">{clock(e.at)}</span>
              <span className="req-operation">{e.operation}</span>
              <span className="req-latency">{e.latencyMs}ms</span>
              <span className={`req-status ${e.ok ? "req-status-ok" : "req-status-err"}`}>
                {e.ok ? "ok" : "error"}
              </span>
              {!e.ok && e.error && <span className="req-error">{e.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
