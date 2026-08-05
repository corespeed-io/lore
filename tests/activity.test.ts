import { expect, test } from "vitest";
import { MAX_ACTIVITY_DAYS, dailyCounts } from "../src/components/ActivityChart.js";

test("dailyCounts builds per-day counts through today", () => {
  const s = dailyCounts(["2026-06-19", "2026-06-19", "2026-06-22"], "2026-06-23");
  expect(s).toHaveLength(MAX_ACTIVITY_DAYS);
  expect(s.find((d) => d.label === "2026-06-19")?.count).toBe(2);
  expect(s.find((d) => d.label === "2026-06-20")?.count).toBe(0);
  expect(s.find((d) => d.label === "2026-06-22")?.count).toBe(1);
  expect(s.at(-1)?.count).toBe(0); // no activity today
});

test("dailyCounts keeps a fixed window for a single recent activity day", () => {
  const s = dailyCounts(["2026-06-19", "2026-06-19"], "2026-06-19");
  expect(s).toHaveLength(MAX_ACTIVITY_DAYS);
  expect(s.at(-1)).toEqual({ label: "2026-06-19", count: 2 });
});

test("dailyCounts caps old histories to a bounded recent window", () => {
  const s = dailyCounts(["2020-01-01", "2026-01-02", "2026-06-29"], "2026-06-30");
  expect(s).toHaveLength(MAX_ACTIVITY_DAYS);
  expect(s[0]?.label).toBe("2026-01-02");
  expect(s.at(-2)?.count).toBe(1);
  expect(s.at(-1)?.label).toBe("2026-06-30");
});

test("dailyCounts excludes future dates without hiding recent activity", () => {
  const s = dailyCounts(["2026-06-29", "2027-01-01"], "2026-06-30");
  expect(s).toHaveLength(MAX_ACTIVITY_DAYS);
  expect(s.find((d) => d.label === "2026-06-29")?.count).toBe(1);
  expect(s.reduce((total, day) => total + day.count, 0)).toBe(1);
});
