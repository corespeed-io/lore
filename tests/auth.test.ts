import { existsSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, expect, test } from "vitest";
import { checkAuth } from "../src/lib/auth.js";
import { middleware } from "../src/middleware.js";

const cookies = (m: Record<string, string> = {}) => ({
  get: (n: string) => (n in m ? { value: m[n] } : undefined),
});

// A real brain credential, because the middleware now VALIDATES the bearer
// instead of merely noticing one. Before, any string got past the gate, so these
// tests could use invented tokens; that was the defect, not a convenience.
const VALID = "brain-write-token-for-limiter-tests";

// The limiter's bucket map is module-level and does not reset between tests, so
// every test that counts requests needs an identity of its own — otherwise one
// test's exhausted bucket is the next one's mystery 429. The file already relied
// on this (each test used a different invented token); now that the middleware
// validates the credential, "different" has to mean "differently VALID".
function credential(name: string): string {
  const token = `brain-write-token-${name}`;
  process.env.BRAIN_WRITE_TOKEN = token;
  return `Bearer ${token}`;
}

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
  process.env.BRAIN_WRITE_TOKEN = VALID;
  // Reflect.deleteProperty, NOT `= undefined`: Node coerces that to the STRING
  // "undefined", which is 16+ characters and would become a working credential.
  Reflect.deleteProperty(process.env, "BRAIN_READ_TOKEN");
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
// CHANGED TWICE, both said out loud. It first stopped sending no credential at
// all, because a brain route refuses a Bearer-less request at the gate. It now
// sends a VALID one, because the gate validates rather than merely notices: an
// invented token is refused here, so it could no longer reach the 200 this test
// counts. The claim under test — viewer gate skipped, limiter enforced — is
// unchanged.
test.each([
  ["/api/export", 10],
  ["/api/maintenance", 60],
  ["/api/import", 120],
  ["/api/mcp", 600],
])("%s skips the viewer gate but still 429s past %i/min", async (path, max) => {
  const h = { authorization: credential(`scope-${path.replace(/\W/g, "-")}`) };
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
  // CHANGED, deliberately and in the strengthening direction: this used to read
  // `[401]`. A refused caller is now CHARGED before it is refused, so past the
  // route's 600 the answer becomes 429. Neither is a 200, which is the claim.
  expect([...codes].sort()).toEqual([401, 429]);
});

// Same rotation, now by a caller that does present a credential: the email is
// not identity, the token is, so all 700 land in one bucket.
test("rotating the Access email cannot dodge a brain route's bucket", async () => {
  const auth = credential("email-rotation");
  const h = (i: number) => ({
    authorization: auth,
    "cf-access-authenticated-user-email": `burner-${i}@evil.test`,
  });
  for (let i = 0; i < 600; i++) expect((await mw("/api/mcp", h(i))).status).toBe(200);
  expect((await mw("/api/mcp", h(600))).status).toBe(429);
});

// REWRITTEN, because the old version passed for the wrong reason and an
// adversarial pass proved it. It rotated garbage bearers and asserted they were
// limited — but it also sent x-forwarded-for, so what it actually exercised was
// the address bucket. Strip that one header (a BARE origin: `next start` or the
// Dockerfile with nothing in front) and there was no address to charge, every
// invented token minted its own `t:` bucket, and 700 rotated burners were 700
// x 200. The middleware now validates the credential, so an invented token never
// reaches a `t:` bucket at all — it is charged to the rejected-caller bucket,
// which is the one thing the caller cannot vary.
test.each([
  ["behind a proxy", { "x-forwarded-for": "203.0.113.9" }],
  ["on a bare origin, the case that used to be free", {}],
])("rotating an invalid bearer buys nothing (%s)", async (_label, extra) => {
  const h = (i: number) => ({ authorization: `Bearer token-rotation-burner-${i}`, ...extra });
  const codes = new Set<number>();
  for (let i = 0; i < 700; i++) codes.add((await mw("/api/mcp", h(i))).status);
  expect(codes.has(200), "an invented credential was let through").toBe(false);
  expect(codes.has(429), "rotation was never limited").toBe(true);
});

// THE FIX'S OWN OWN-GOAL, caught by an adversarial pass over it. Charging every
// rejected caller and letting the 429 replace the denial made the LOGIN CHALLENGE
// rate-limitable: on a bare origin every unauthenticated caller is `bad:anon`, so
// 600 credential-less GETs exhausted that one bucket and the next honest visitor
// got a 429 with no `WWW-Authenticate` header. A browser only prompts on a 401
// that carries it, so the owner could not log in to their own console — the same
// lockout the fix set out to close, moved from the `ip:` bucket to the `bad:` one.
test("a flood cannot deny an honest visitor their login challenge", async () => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  // No address headers at all: `next start` or the Dockerfile with nothing in
  // front, which is where every unauthenticated caller shares one bucket.
  for (let i = 0; i < 700; i++) await mw("/");
  const honest = await mw("/");
  expect(honest.status, "the honest visitor was rate-limited out of logging in").toBe(401);
  expect(
    honest.headers.get("WWW-Authenticate"),
    "the browser was not told how to authenticate",
  ).toBe("Basic");
  // ...and the caller that already holds the password still gets in.
  const ok = await mw("/", { authorization: `Basic ${btoa("x:secret")}` });
  expect(ok.status).toBe(200);
});

// THE OTHER FACE OF THE SAME BUG, and the more damaging one: the address bucket
// used to be charged BEFORE the credential was checked, so traffic that was
// always going to 401 spent the owner's quota. /api/export is 10/min, so eleven
// credential-less requests from an address locked the real owner out of it for
// the rest of the window.
test("credential-less traffic cannot spend the owner's quota", async () => {
  const from = { "x-forwarded-for": "203.0.113.200" };
  const auth = credential("owner-quota");
  for (let i = 0; i < 11; i++) {
    await mw("/api/export", { authorization: `Bearer not-a-real-token-${i}`, ...from });
  }
  const owner = await mw("/api/export", { authorization: auth, ...from });
  expect(owner.status, "the owner was locked out by traffic that never authenticated").toBe(200);
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
    // Its own address: the rejected-caller bucket is keyed by address, and a
    // sibling test above deliberately exhausts the addressless one.
    expect((await mw(path, { "x-forwarded-for": `198.51.100.${path.length}` })).status).toBe(401);
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
