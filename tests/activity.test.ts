import { expect, test } from "vitest";
import { dailyCounts } from "../src/components/ActivityChart.js";

test("dailyCounts builds per-day counts through today", () => {
  const s = dailyCounts(["2026-06-19", "2026-06-19", "2026-06-22"], "2026-06-23");
  expect(s.map((d) => d.label)).toEqual([
    "2026-06-19",
    "2026-06-20",
    "2026-06-21",
    "2026-06-22",
    "2026-06-23",
  ]);
  expect(s[0].count).toBe(2); // two on the 19th
  expect(s[1].count).toBe(0); // quiet day stays in the series as a zero bar
  expect(s[3].count).toBe(1); // one on the 22nd
  expect(s.at(-1)?.count).toBe(0); // no activity today
});

test("dailyCounts returns [] with fewer than two distinct days", () => {
  expect(dailyCounts(["2026-06-19", "2026-06-19"], "2026-06-19")).toEqual([]);
});
