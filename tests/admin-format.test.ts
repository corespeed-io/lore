import { expect, test } from "vitest";
import {
  agentCounts,
  agentOptions,
  calibrationGeneratedAt,
  calibrationIssues,
  calibrationOutcomes,
  decimal,
  dollars,
  formatParams,
  leasePressureColor,
  percent,
  relativeTime,
  scopeList,
} from "../src/lib/admin-format.js";
import { agents, calibrationProfile, jobsSnapshot, requestsPage } from "./fixtures/admin.js";

test("calibrationOutcomes reconstructs correct/incorrect/partial from scorecard aggregates", () => {
  // 8 resolved, 50% accuracy, 0 partial → 4 correct / 4 wrong (exact)
  expect(
    calibrationOutcomes({ ...calibrationProfile, total_resolved: 8, accuracy: 0.5, partial_rate: 0 }),
  ).toEqual({ correct: 4, incorrect: 4, partial: 0, total: 8 });
  // with partials: 10 resolved, 20% partial (=2), accuracy 75% over the 8 non-partial → 6/2
  expect(
    calibrationOutcomes({ ...calibrationProfile, total_resolved: 10, accuracy: 0.75, partial_rate: 0.2 }),
  ).toEqual({ correct: 6, incorrect: 2, partial: 2, total: 10 });
  // guards: no data / no accuracy → null
  expect(calibrationOutcomes({ ...calibrationProfile, total_resolved: 0 })).toBeNull();
  expect(
    calibrationOutcomes({ ...calibrationProfile, total_resolved: 8, accuracy: null }),
  ).toBeNull();
});

test("formatParams matches upstream summary (query / slug / ~partial / limit / +N)", () => {
  expect(formatParams(null)).toBeNull();
  expect(formatParams({})).toBeNull();
  expect(formatParams({ query: "moat", limit: 5, foo: 1, bar: 2 })).toBe(
    '"moat" · limit=5 · +2 params',
  );
  expect(formatParams({ slug: "companies/acme" })).toBe("companies/acme");
  expect(formatParams({ partial: "ac" })).toBe("~ac");
});

test("relativeTime buckets", () => {
  const now = Date.now();
  expect(relativeTime(null)).toBe("—");
  expect(relativeTime("not-a-date")).toBe("—");
  expect(relativeTime(new Date(now - 10_000).toISOString(), now)).toBe("just now");
  expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m ago");
  expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3h ago");
  expect(relativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe("2d ago");
});

test("dollars + lease-pressure severity color", () => {
  expect(dollars(2000)).toBe("$20.00");
  expect(dollars(8000)).toBe("$80.00");
  expect(leasePressureColor(0)).toMatch(/muted/);
  expect(leasePressureColor(3)).toBe("#d29922");
  expect(leasePressureColor(9)).toBe("#e5484d");
});

test("agentOptions: unique by token_name, label = agent_name (upstream rows)", () => {
  expect(agentOptions(requestsPage.rows)).toEqual([
    { value: "gbrain-ui-ro", label: "gbrain-ui-ro" },
    { value: "garry", label: "Garry" },
  ]);
});

test("agentCounts excludes revoked; scopeList splits space/comma", () => {
  expect(agentCounts(agents)).toEqual({ active: 2, total: 3 });
  expect(scopeList("read write")).toEqual(["read", "write"]);
  expect(scopeList("read,write")).toEqual(["read", "write"]);
  expect(scopeList(undefined)).toEqual([]);
});

test("calibration formatting and health gates", () => {
  expect(percent(0.782, 1)).toBe("78.2%");
  expect(percent(null)).toBe("—");
  expect(decimal(0.18333, 3)).toBe("0.183");
  expect(decimal(undefined)).toBe("—");
  expect(calibrationGeneratedAt(calibrationProfile)).toBe(calibrationProfile.generated_at);
  expect(calibrationIssues(calibrationProfile)).toEqual([
    {
      key: "coverage",
      label: "Grade coverage",
      detail: "70% graded this cycle",
    },
    {
      key: "voice",
      label: "Voice gate",
      detail: "template fallback after 2 attempts",
    },
  ]);
});

test("fixtures carry the upstream operational shapes", () => {
  // requests: { rows, total, page, pages }
  expect(requestsPage).toMatchObject({ total: 42, page: 1, pages: 3 });
  expect(requestsPage.rows[0]).toHaveProperty("error_message");
  // jobs: queue_health / by_type / lease_pressure_1h / top_errors / budget_owners
  expect(jobsSnapshot.queue_health.stalled).toBe(2);
  expect(jobsSnapshot.by_type[0]).toMatchObject({ name: "dream", dead: 1 });
  expect(jobsSnapshot.top_errors[0].count).toBe(3);
  // calibration populated
  expect(calibrationProfile.holder).toBe("team");
  expect(calibrationProfile.voice_gate_passed).toBe(false);
  expect(calibrationProfile.total_resolved).toBe(18);
  expect(calibrationProfile.active_bias_tags).toEqual(["timeline_overconfidence"]);
});
