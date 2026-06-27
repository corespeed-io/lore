import { afterEach, expect, test } from "vitest";
import {
  clearRequestLog,
  getRequestLog,
  recordRequest,
  subscribeRequestLog,
} from "../src/lib/request-log.js";

afterEach(() => clearRequestLog());

test("records newest-first with incrementing ids", () => {
  recordRequest({ tool: "search", at: 1, latencyMs: 5, ok: true });
  recordRequest({ tool: "get_page", at: 2, latencyMs: 9, ok: false, error: "boom" });
  const log = getRequestLog();
  expect(log.map((e) => e.tool)).toEqual(["get_page", "search"]);
  expect(log[0].id).toBeGreaterThan(log[1].id);
  expect(log[0]).toMatchObject({ ok: false, error: "boom", latencyMs: 9 });
});

test("caps at 50 entries, dropping the oldest", () => {
  for (let i = 0; i < 60; i++) recordRequest({ tool: `t${i}`, at: i, latencyMs: 1, ok: true });
  const log = getRequestLog();
  expect(log).toHaveLength(50);
  expect(log[0].tool).toBe("t59"); // newest kept
  expect(log.at(-1)?.tool).toBe("t10"); // 0..9 dropped
});

test("getRequestLog is referentially stable until the next record (no render loop)", () => {
  recordRequest({ tool: "a", at: 1, latencyMs: 1, ok: true });
  const snap = getRequestLog();
  expect(getRequestLog()).toBe(snap);
  recordRequest({ tool: "b", at: 2, latencyMs: 1, ok: true });
  expect(getRequestLog()).not.toBe(snap);
});

test("subscribers fire on record and stop after unsubscribe", () => {
  let n = 0;
  const unsub = subscribeRequestLog(() => {
    n++;
  });
  recordRequest({ tool: "a", at: 1, latencyMs: 1, ok: true });
  recordRequest({ tool: "b", at: 2, latencyMs: 1, ok: true });
  expect(n).toBe(2);
  unsub();
  recordRequest({ tool: "c", at: 3, latencyMs: 1, ok: true });
  expect(n).toBe(2);
});
