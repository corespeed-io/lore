import { expect, test } from "vitest";
import { activitySeries } from "../src/components/ActivityChart.js";

test("activitySeries builds a daily cumulative series through today", () => {
  const s = activitySeries(["2026-06-19", "2026-06-19", "2026-06-22"], "2026-06-23");
  expect(s.map((d) => d.label)).toEqual([
    "2026-06-19",
    "2026-06-20",
    "2026-06-21",
    "2026-06-22",
    "2026-06-23",
  ]);
  expect(s[0].cum).toBe(2); // two on the 19th
  expect(s.at(-1)?.cum).toBe(3); // monotonic, ends at total
});

test("activitySeries returns [] with fewer than two distinct days", () => {
  expect(activitySeries(["2026-06-19", "2026-06-19"], "2026-06-19")).toEqual([]);
});
