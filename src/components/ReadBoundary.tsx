"use client";

import { useEffect, useState } from "react";

// Makes Lore's security boundary visible: the exact read-only gbrain tools the
// server will proxy (from /api/tools, which returns READ_ONLY_TOOLS). Lore can
// call nothing else — no writes, no admin — and this panel proves it.
export function ReadBoundary() {
  const [tools, setTools] = useState<string[] | null>(null);

  useEffect(() => {
    fetch("/api/tools")
      .then((r) => (r.ok ? r.json() : { tools: [] }))
      .then((d: { tools?: string[] }) => setTools(d.tools ?? []))
      .catch(() => setTools([]));
  }, []);

  return (
    <div className="panel-card">
      <p className="panel-card-title">Read boundary</p>
      <p style={{ color: "var(--muted-soft)", fontSize: "13px", margin: "0 0 10px" }}>
        Lore is read-only. The server will only proxy these gbrain tools — never a write or admin
        call.
      </p>
      {tools === null ? (
        <p style={{ color: "var(--muted-soft)", fontSize: "13px", margin: 0 }}>Loading…</p>
      ) : tools.length === 0 ? (
        <p style={{ color: "var(--muted-soft)", fontSize: "13px", margin: 0 }}>
          Couldn't load the allowlist.
        </p>
      ) : (
        <div className="tool-chips">
          {tools.map((t) => (
            <span key={t} className="tool-chip">
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
