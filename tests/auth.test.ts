import { existsSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import { checkAuth } from "../src/lib/auth.js";
import { middleware } from "../src/middleware.js";

const cookies = (m: Record<string, string> = {}) => ({
  get: (n: string) => (n in m ? { value: m[n] } : undefined),
});

beforeEach(() => {
  for (const k of [
    "AUTH_MODE",
    "ALLOW_INSECURE",
    "UI_PASSWORD",
    "ACCESS_AUD",
    "ACCESS_TEAM_DOMAIN",
  ]) {
    delete process.env[k];
  }
});

test("none mode fails closed without ALLOW_INSECURE", async () => {
  process.env.AUTH_MODE = "none";
  const r = await checkAuth(new Headers(), cookies());
  expect(r.ok).toBe(false);
  expect(r.status).toBe(403);
});

test("none mode allows only with explicit ALLOW_INSECURE", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  expect((await checkAuth(new Headers(), cookies())).ok).toBe(true);
});

test("none-mode 403 explains the real cause (AUTH_MODE / ALLOW_INSECURE)", async () => {
  process.env.AUTH_MODE = "none";
  const r = await checkAuth(new Headers(), cookies());
  expect(r.ok).toBe(false);
  expect(r.detail).toMatch(/ALLOW_INSECURE/);
  expect(r.detail).not.toMatch(/Cloudflare/); // no more misleading "Cloudflare Access required"
});

test("password mode with no UI_PASSWORD fails closed and says so", async () => {
  process.env.AUTH_MODE = "password";
  const r = await checkAuth(new Headers(), cookies());
  expect(r.ok).toBe(false);
  expect(r.status).toBe(403);
  expect(r.detail).toMatch(/UI_PASSWORD/);
});

test("password mode rejects without basic auth", async () => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  const r = await checkAuth(new Headers(), cookies());
  expect(r.ok).toBe(false);
  expect(r.status).toBe(401);
  expect(r.wwwAuthenticate).toBe(true);
});

test("password mode accepts the right password (any username)", async () => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  const h = new Headers({ authorization: `Basic ${btoa("x:secret")}` });
  expect((await checkAuth(h, cookies())).ok).toBe(true);
});

test("proxy mode fails closed when Access vars are missing", async () => {
  process.env.AUTH_MODE = "proxy";
  const h = new Headers({ "cf-access-jwt-assertion": "tok" });
  expect((await checkAuth(h, cookies())).ok).toBe(false);
});

test("proxy mode rejects a forged / unverifiable token", async () => {
  process.env.AUTH_MODE = "proxy";
  process.env.ACCESS_AUD = "aud";
  process.env.ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com";
  // A bare string is not a valid JWS; jwtVerify throws before any network call,
  // so checkAuth fails closed — the old presence-only check would have allowed it.
  const h = new Headers({ "cf-access-jwt-assertion": "tok" });
  expect((await checkAuth(h, cookies())).ok).toBe(false);
});

// Middleware wiring. The env is stripped by beforeEach, so the viewer gate is
// fail-closed (403) for every request below unless the route is exempt.
const req = (path: string, ip = "10.0.0.1") =>
  new NextRequest(`http://x${path}`, { headers: { "cf-connecting-ip": ip } });

// The four bearer-authed brain routes are exempt from the VIEWER gate only.
// Exempting them with an early `return NextResponse.next()` also skipped the
// rate limiter, so their LIMITS entries were dead code — 700 requests to
// /api/mcp all answered 200 while /api/call correctly 429'd. Limits here are
// hand-read from src/middleware.ts, never computed from it.
test.each([
  ["/api/export", 10],
  ["/api/maintenance", 60],
  ["/api/import", 120],
  ["/api/mcp", 600],
])("%s skips the viewer gate but still 429s past %i/min", async (path, max) => {
  for (let i = 0; i < max; i++) {
    // 200 == NextResponse.next(); a 401/403 here would mean the viewer gate ran.
    expect((await middleware(req(path))).status).toBe(200);
  }
  const limited = await middleware(req(path));
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ detail: "rate limit exceeded" });
});

test("the brain-route exemption does not leak to other routes", async () => {
  const res = await middleware(req("/api/call"));
  expect(res.status).toBe(403);
  expect((await res.json()).detail).toMatch(/ALLOW_INSECURE/);
});

test("/api/health is the one route with neither gate", async () => {
  expect((await middleware(req("/api/health"))).status).toBe(200);
});

// Placement guard. checkAuth is only reachable because Next picks the
// middleware up, and with app code under src/ it looks ONLY at
// src/middleware.ts — a root-level middleware.ts compiles fine, ships an
// empty middleware manifest, and silently serves every route unauthenticated.
// No behavioral test catches that, so assert the path itself.
test("middleware lives where Next will actually load it", () => {
  const root = new URL("..", import.meta.url);
  expect(existsSync(new URL("src/middleware.ts", root))).toBe(true);
  expect(existsSync(new URL("middleware.ts", root))).toBe(false);
});
