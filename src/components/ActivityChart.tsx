"use client";

import type { PageHit } from "@/lib/types";

const DAY = 86_400_000;

// Per-day activity count from the first activity day through `todayISO` (inclusive).
// Pure + deterministic given inputs so it's unit-testable.
export function dailyCounts(
  dateStrs: string[],
  todayISO: string,
): { label: string; count: number }[] {
  const perDay: Record<string, number> = {};
  for (const d of dateStrs) {
    const k = d.slice(0, 10);
    if (k) perDay[k] = (perDay[k] ?? 0) + 1;
  }
  const days = Object.keys(perDay);
  if (days.length < 2) return [];
  const start = days.reduce((a, b) => (a < b ? a : b));
  const out: { label: string; count: number }[] = [];
  const end = new Date(`${todayISO}T00:00:00Z`).getTime();
  for (let t = new Date(`${start}T00:00:00Z`).getTime(); t <= end; t += DAY) {
    const k = new Date(t).toISOString().slice(0, 10);
    out.push({ label: k, count: perDay[k] ?? 0 });
  }
  return out;
}

function fmt(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function ActivityChart({ pages }: { pages: PageHit[] }) {
  const dates = pages.map((p) => p.updated_at ?? "").filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);
  const series = dailyCounts(dates, today);
  if (series.length < 2) return null;

  const W = 600;
  const H = 150;
  const padX = 6;
  const padTop = 10;
  const padBot = 4;
  const n = series.length;
  const maxY = Math.max(...series.map((d) => d.count), 1);
  const slot = (W - 2 * padX) / n;
  const barW = Math.max(slot * 0.62, 1);
  // "updates" (activity events), deliberately NOT "pages" — the page count lives
  // in the hero/stat cards (graph nodes). Two different denominators on one
  // dashboard read as a bug, so the chart speaks in activity, not page totals.
  const total = dates.length;

  return (
    <div className="panel-card chart-card">
      <p className="panel-card-title">Daily activity</p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="activity-chart"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {series.map((d, i) => {
          const h = (d.count / maxY) * (H - padTop - padBot);
          const bx = padX + i * slot + (slot - barW) / 2;
          return (
            <rect
              key={d.label}
              x={bx.toFixed(1)}
              y={(H - padBot - h).toFixed(1)}
              width={barW.toFixed(1)}
              height={(d.count > 0 ? Math.max(h, 1) : 0).toFixed(1)}
              className="chart-bar"
            />
          );
        })}
      </svg>
      <div className="chart-axis">
        <span>{fmt(series[0].label)}</span>
        <span>{total} updates</span>
        <span>{fmt(series[n - 1].label)}</span>
      </div>
    </div>
  );
}
