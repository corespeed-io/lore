"use client";

import type { PageHit } from "@/lib/types";

const DAY = 86_400_000;
export const MAX_ACTIVITY_DAYS = 180;

// Per-day activity counts within a bounded recent window. The page list itself
// is capped, so rendering years of zero-value SVG bars adds no useful signal.
// Pure + deterministic given inputs so it is unit-testable.
export function dailyCounts(
  dateStrs: string[],
  todayISO: string,
  maxDays = MAX_ACTIVITY_DAYS,
): { label: string; count: number }[] {
  const perDay: Record<string, number> = {};
  for (const d of dateStrs) {
    const k = d.slice(0, 10);
    if (k) perDay[k] = (perDay[k] ?? 0) + 1;
  }
  const end = new Date(`${todayISO}T00:00:00Z`).getTime();
  const windowDays = Math.max(1, Math.floor(maxDays));
  const cutoff = end - (windowDays - 1) * DAY;
  const days = Object.keys(perDay).filter((day) => {
    const time = new Date(`${day}T00:00:00Z`).getTime();
    return time >= cutoff && time <= end;
  });
  if (days.length < 2) return [];
  const start = days.reduce((a, b) => (a < b ? a : b));
  const out: { label: string; count: number }[] = [];
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

  return (
    <div className="panel-card chart-card">
      <p className="panel-card-title">Daily activity · last {MAX_ACTIVITY_DAYS} days</p>
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
        <span>{fmt(series[n - 1].label)}</span>
      </div>
    </div>
  );
}
