"use client";

import type { PageHit } from "@/lib/types";

const DAY = 86_400_000;

// Daily cumulative count from the first activity day through `todayISO` (inclusive).
// Pure + deterministic given inputs so it's unit-testable.
export function activitySeries(
  dateStrs: string[],
  todayISO: string,
): { label: string; cum: number }[] {
  const perDay: Record<string, number> = {};
  for (const d of dateStrs) {
    const k = d.slice(0, 10);
    if (k) perDay[k] = (perDay[k] ?? 0) + 1;
  }
  const days = Object.keys(perDay);
  if (days.length < 2) return [];
  const start = days.reduce((a, b) => (a < b ? a : b));
  const out: { label: string; cum: number }[] = [];
  let cum = 0;
  const end = new Date(`${todayISO}T00:00:00Z`).getTime();
  for (let t = new Date(`${start}T00:00:00Z`).getTime(); t <= end; t += DAY) {
    const k = new Date(t).toISOString().slice(0, 10);
    cum += perDay[k] ?? 0;
    out.push({ label: k, cum });
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
  const series = activitySeries(dates, today);
  if (series.length < 2) return null;

  const W = 600;
  const H = 150;
  const padX = 6;
  const padTop = 10;
  const padBot = 4;
  const n = series.length;
  const maxY = series[n - 1].cum || 1;
  const x = (i: number) => padX + (i / (n - 1)) * (W - 2 * padX);
  const y = (v: number) => padTop + (1 - v / maxY) * (H - padTop - padBot);
  const line = series
    .map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(d.cum).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)} ${H - padBot} L${x(0).toFixed(1)} ${H - padBot} Z`;

  return (
    <div className="panel-card chart-card">
      <p className="panel-card-title">Memory growth</p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="activity-chart"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d={area} className="chart-area" />
        <path d={line} className="chart-line" />
      </svg>
      <div className="chart-axis">
        <span>{fmt(series[0].label)}</span>
        <span>{maxY} memories</span>
        <span>{fmt(series[n - 1].label)}</span>
      </div>
    </div>
  );
}
