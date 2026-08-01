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
// The limiter's buckets are module state shared by every test in this file, so
// each test below uses its OWN token / client IP / path and they never collide.
const mw = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  middleware(new NextRequest(`http://x${path}`, { method, headers }));
const req = (path: string, ip = "10.0.0.1") =>
  new NextRequest(`http://x${path}`, { headers: { "cf-connecting-ip": ip } });

// The four bearer-authed brain routes are exempt from the VIEWER gate only.
// Exempting them with an early `return NextResponse.next()` also skipped the
// rate limiter, so their LIMITS entries were dead code — 700 requests to
// /api/mcp all answered 200 while /api/call correctly 429'd. Limits here are
// hand-read from src/middleware.ts, never computed from it.
// CHANGED: this used to send no credential at all. A brain route now refuses a
// Bearer-less request at the gate (see the next test), so the credential is
// what the limiter keys on and the request has to carry one; the claim under
// test — viewer gate skipped, limiter enforced — is unchanged.
test.each([
  ["/api/export", 10],
  ["/api/maintenance", 60],
  ["/api/import", 120],
  ["/api/mcp", 600],
])("%s skips the viewer gate but still 429s past %i/min", async (path, max) => {
  const h = { authorization: "Bearer per-scope-bucket-token-0001" };
  for (let i = 0; i < max; i++) {
    // 200 == NextResponse.next(); a 401/403 here would mean the viewer gate ran.
    expect((await mw(path, h)).status).toBe(200);
  }
  const limited = await mw(path, h);
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ detail: "rate limit exceeded" });
});

// THE refutation, verbatim: 700 POSTs to /api/mcp from one source IP, each with
// a fresh cf-access-authenticated-user-email and no credential of any kind.
// That header is only trustworthy where the Access JWT is verified, and on a
// brain route it never is — so it bought 700 x 200, one bucket per burner.
test("700 credential-less /api/mcp POSTs with rotating burner emails get zero 200s", async () => {
  const codes = new Set<number>();
  for (let i = 0; i < 700; i++) {
    const res = await mw(
      "/api/mcp",
      {
        "cf-access-authenticated-user-email": `burner-${i}@evil.test`,
        "cf-connecting-ip": "198.51.100.7",
        "x-forwarded-for": "198.51.100.7",
      },
      "POST",
    );
    codes.add(res.status);
  }
  expect([...codes]).toEqual([401]);
});

// Same rotation, now by a caller that does present a credential: the email is
// not identity, the token is, so all 700 land in one bucket.
test("rotating the Access email cannot dodge a brain route's bucket", async () => {
  const h = (i: number) => ({
    authorization: "Bearer email-rotation-fixed-token-02",
    "cf-access-authenticated-user-email": `burner-${i}@evil.test`,
  });
  for (let i = 0; i < 600; i++) expect((await mw("/api/mcp", h(i))).status).toBe(200);
  expect((await mw("/api/mcp", h(600))).status).toBe(429);
});

// And the sibling path: rotate the CREDENTIAL instead. A per-token bucket alone
// would be dodged by a caller sending garbage tokens (each 401s downstream, but
// each would also mint a bucket), so the address the proxy stamped is charged
// too — "all from a single source IP" is the part the caller cannot rotate.
test("rotating the bearer token cannot dodge the source-address bucket", async () => {
  const h = (i: number) => ({
    authorization: `Bearer token-rotation-burner-${i}`,
    "x-forwarded-for": "203.0.113.9",
  });
  for (let i = 0; i < 600; i++) expect((await mw("/api/mcp", h(i))).status).toBe(200);
  expect((await mw("/api/mcp", h(600))).status).toBe(429);
});

// The over-enforcement half of the same bug: behind a router that sets only
// x-forwarded-for (Railway, Vercel, any nginx), every caller collapsed into one
// "anon" bucket, so 123 honest agents produced 120 x 200 + 3 x 429 on a 120/min
// route and locked each other out.
test("honest callers seen only through x-forwarded-for get their own buckets", async () => {
  process.env.ALLOW_INSECURE = "1";
  for (let i = 0; i < 123; i++) {
    expect((await mw("/api/call", { "x-forwarded-for": `192.0.2.${i}` })).status).toBe(200);
  }
});

// ...but x-forwarded-for is a list the caller can prepend to, so only the
// right-most entry (the one the nearest proxy appended) may be keyed on. Naively
// taking the left-hand entry would hand this caller a bucket per request.
test("prepending to x-forwarded-for does not mint buckets", async () => {
  process.env.ALLOW_INSECURE = "1";
  const h = (i: number) => ({ "x-forwarded-for": `10.9.9.${i}, 203.0.113.44` });
  for (let i = 0; i < 120; i++) expect((await mw("/api/call", h(i))).status).toBe(200);
  expect((await mw("/api/call", h(120))).status).toBe(429);
});

// A path with no rule used to mean no limit. Rotating the path must not be a
// free bucket either, so everything unmatched shares one bucket per caller.
test("unmatched paths are limited, and rotating the path buys nothing", async () => {
  process.env.ALLOW_INSECURE = "1";
  const h = { "x-forwarded-for": "203.0.113.77" };
  for (let i = 0; i < 600; i++) expect((await mw(`/page-${i}`, h)).status).toBe(200);
  expect((await mw("/another-page", h)).status).toBe(429);
});

// Paths UNDER a brain route matched no LIMITS key and no BRAIN_ROUTES entry, so
// they were neither auth-gated nor limited — 40/40 200s against the catch-all
// page. Nothing legitimate lives there; they answer to the brain route's gate.
test.each(["/api/mcp/", "/api/mcp/anything", "/api/export/x"])(
  "%s is not an unguarded amplifier",
  async (path) => {
    process.env.ALLOW_INSECURE = "1";
    expect((await mw(path)).status).toBe(401);
  },
);

test("the brain-route exemption does not leak to other routes", async () => {
  const res = await middleware(req("/api/call"));
  expect(res.status).toBe(403);
  expect((await res.json()).detail).toMatch(/ALLOW_INSECURE/);
});

// Deliberate: the liveness probe answers a static {status:"ok"} with no DB and
// no upstream call, and a 429'd healthcheck turns a flood into a restart loop.
// So it is exempt from the limiter too — pinned here so the exemption is a
// decision, not an oversight.
test("/api/health is the one route with neither gate, limiter included", async () => {
  for (let i = 0; i < 700; i++) expect((await middleware(req("/api/health"))).status).toBe(200);
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

// LAST on purpose: it evicts every bucket the tests above created.
// The bucket map is module state with no accessor, so the hard cap is asserted
// through the one behaviour a hard cap has — an old bucket is GONE. Sweeping
// only expired entries was no bound at all: mid-window nothing is expired, so a
// caller rotating identity added ~17 MB of live heap and kept it.
test("the bucket map is hard-capped, not just swept for expiry", async () => {
  process.env.ALLOW_INSECURE = "1";
  const victim = { "x-forwarded-for": "198.18.0.1" };
  for (let i = 0; i < 60; i++) expect((await mw("/api/graph", victim)).status).toBe(200);
  expect((await mw("/api/graph", victim)).status).toBe(429);

  // MAX_KEYS (10_000) distinct identities inside one window, plus one.
  for (let i = 0; i < 10_001; i++) {
    await mw("/api/graph", { "x-forwarded-for": `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}` });
  }
  // The victim's bucket was among the oldest, so a bounded map has dropped it.
  expect((await mw("/api/graph", victim)).status).toBe(200);
}, 60_000);
