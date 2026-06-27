import { expect, test } from "vitest";
import {
  agentCounts,
  agentOptions,
  dollars,
  formatParams,
  leasePressureColor,
  relativeTime,
  scopeList,
} from "../src/lib/admin-format.js";
import { agents, calibrationProfile, jobsSnapshot, requestsPage } from "./fixtures/admin.js";

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
});
