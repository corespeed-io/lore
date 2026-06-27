"use client";

import { getRequestLog, getServerRequestLog, subscribeRequestLog } from "@/lib/request-log";
import { useSyncExternalStore } from "react";

// Read API connection health, derived purely from this session's request log —
// no admin tools, no token introspection. Mirrors gbrain's "live activity" +
// error-rate idea, scoped to what a read-only client can actually see.
export function ConnectionHealth() {
  const log = useSyncExternalStore(subscribeRequestLog, getRequestLog, getServerRequestLog);
  const total = log.length;
  const errors = log.filter((e) => !e.ok).length;
  const lastErr = log.find((e) => !e.ok)?.error;
  const rate = total ? Math.round((errors / total) * 100) : 0;

  const state = total === 0 ? "idle" : log[0]?.ok ? "connected" : "degraded";
  const label = state === "idle" ? "No calls yet" : state === "connected" ? "Connected" : "Errors";

  return (
    <div className="panel-card">
      <p className="panel-card-title">Read API</p>
      <div className="health-line">
        <span className={`health-dot health-dot-${state}`} />
        <span className="health-label">{label}</span>
      </div>
      <div className="health-stats">
        <span>
          {total} call{total === 1 ? "" : "s"} this session
        </span>
        <span className={errors ? "health-err" : "health-ok"}>
          {errors} error{errors === 1 ? "" : "s"}
          {total ? ` · ${rate}%` : ""}
        </span>
      </div>
      {lastErr && <p className="health-last-err">Last error: {lastErr}</p>}
    </div>
  );
}
