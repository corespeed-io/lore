import { checkAuth } from "@/lib/auth";
import { loadConfig } from "@/lib/config";
import { grantFor, parseBearer } from "@/server/auth-bearer";
import { type NextRequest, NextResponse } from "next/server";

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };

// Per-instance fixed-window limiter for the brain-reading routes. Each call is
// a 1:1 proxy onto the shared brain, so an authenticated/compromised account
// could otherwise loop to exhaust its quota.
// ponytail: per-isolate in-memory, fine for a single Railway replica; swap for a
// shared store (Redis) if this ever scales horizontally.
const LIMITS: Record<string, { max: number; windowMs: number }> = {
  "/api/call": { max: 120, windowMs: 60_000 },
  "/api/graph": { max: 60, windowMs: 60_000 },
  // Bearer-authed, so these are not open — but an import loop should not be able
  // to hammer the embeddings provider without bound, and a leaked token should
  // hit a wall long before it has dumped the brain a hundred times.
  "/api/mcp": { max: 600, windowMs: 60_000 },
  "/api/import": { max: 120, windowMs: 60_000 },
  "/api/export": { max: 10, windowMs: 60_000 },
  "/api/maintenance": { max: 60, windowMs: 60_000 },
};
// Every path NOT named above shares one bucket per caller. No rule used to mean
// no limit, so unmatched paths (`/api/tools`, `/api%2fmcp`, any 404 that still
// costs an SSR render) answered floods for free; and a rule PER unmatched path
// would just hand a fresh bucket to every invented path, which is the same
// rotation trick as an invented identity.
const UNMATCHED = { max: 600, windowMs: 60_000 };

// Paths that authenticate themselves instead of using the viewer gate.
const BRAIN_ROUTES = new Set(["/api/mcp", "/api/import", "/api/export", "/api/maintenance"]);
const hits = new Map<string, { count: number; resetAt: number }>();
// HARD cap on live buckets. Reclaiming only expired ones was no bound at all: a
// caller that rotates identity mints a bucket per request and nothing expires
// until the window closes, so 30k rotated keys simply stayed resident. Memory is
// the invariant that has to hold; limiter accuracy is what degrades under a key
// flood.
const MAX_KEYS = 10_000;

// Which rule a path answers to. Prefix-matched, so anything UNDER a limited
// route shares that route's bucket — and, for a brain route, its credential
// requirement. `/api/mcp/` and `/api/mcp/anything` were neither auth-gated nor
// limited: they missed the exact-match lookup and fell through to the catch-all
// page render.
function scopeOf(path: string): string {
  for (const p of Object.keys(LIMITS)) if (path === p || path.startsWith(`${p}/`)) return p;
  return "*";
}

function overLimit(key: string, rule: { max: number; windowMs: number }, now: number): boolean {
  if (hits.size >= MAX_KEYS) {
    for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    // Still full: evict oldest-first (a Map iterates in insertion order).
    // Forgiving one caller's window is survivable; running the instance out of
    // heap is not.
    for (const k of hits.keys()) {
      if (hits.size < MAX_KEYS) break;
      hits.delete(k);
    }
  }
  const cur = hits.get(key);
  if (!cur || now > cur.resetAt) {
    hits.set(key, { count: 1, resetAt: now + rule.windowMs });
    return false;
  }
  cur.count += 1;
  return cur.count > rule.max;
}

// Per-credential bucket id: hashed and truncated so the token itself is never a
// map key, never in a log line, never in an error.
async function tokenId(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest, 0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The client address OUR infrastructure observed, or null when we cannot see
// one. null — everyone shares a bucket — is the safe answer; inventing an
// identity out of a header the caller types is not a limiter at all.
function clientAddr(headers: Headers): string | null {
  // ONE rule, and it is the general one. This used to prefer `cf-connecting-ip`
  // whenever the auth mode declared a proxy in front, which was a safe inference
  // only while that mode WAS Cloudflare Access: `AUTH_MODE=gateway` now covers
  // oauth2-proxy, Authelia and any ingress, and none of those set or strip that
  // header — so a caller could simply send one and be handed a fresh bucket on
  // every request, which is the limiter turned off. Measured before the change:
  // 400 requests with a rotating cf-connecting-ip, 400 answered, zero 429s.
  //
  // Nothing is lost by dropping it: Cloudflare appends the real client to
  // x-forwarded-for as well, so the right-most entry is the same address.
  //
  // x-forwarded-for is a list and the caller controls the left-hand entries;
  // only the RIGHT-most entry was appended by the proxy nearest us. Reading it
  // at all is what unbreaks honest callers behind a router that sets nothing
  // else — 123 distinct clients used to collapse into one "anon" bucket and
  // 429 each other out of /api/export.
  return headers.get("x-forwarded-for")?.split(",").pop()?.trim() || null;
}

function json(detail: string, status: number, extra: Record<string, string> = {}) {
  return new NextResponse(JSON.stringify({ detail }), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  // The liveness probe is exempt from both gates on purpose: it answers a static
  // {status:"ok"} with no DB and no upstream call, and a 429'd healthcheck turns
  // a flood into a container restart loop — worse than the flood.
  if (path === "/api/health") return NextResponse.next();

  const scope = scopeOf(path);
  const authorization = req.headers.get("authorization");
  const addr = clientAddr(req.headers);

  // AUTHENTICATE FIRST, THEN CHARGE. The old order did the opposite and it cost
  // two defects with one root: the middleware only checked that a Bearer header
  // was PRESENT, and validity was decided later, in the route.
  //   - A presented token is not a proved one, so `t:<hash of whatever was
  //     typed>` handed every INVENTED bearer a private bucket. On a bare origin
  //     (no cf-connecting-ip, no x-forwarded-for) that was the only bucket, so
  //     700 requests under 700 burner tokens were 700 x 200 on /api/mcp. The
  //     existing rotation test passed only because it sent x-forwarded-for.
  //   - Where an address IS observable it was charged BEFORE the credential was
  //     checked, so 10 credential-less requests exhausted /api/export's bucket
  //     for that address and the owner's next real call got a 429. Traffic that
  //     was always going to 401 could spend the owner's quota.
  // So: ask auth-bearer.ts the same question the route asks (which is why that
  // file no longer imports node:crypto), and put rejected callers in a bucket
  // namespace of their own.
  let denial: NextResponse | null = null;
  // Bucket identities. A key must be something the caller PROVES, never a string
  // it merely types: keying on cf-access-authenticated-user-email let a caller
  // with no credential at all rotate burner emails and take 700 x 200 on
  // /api/mcp, because that header is only ever validated where the Access JWT
  // is — and on a brain route it never is.
  const ids: string[] = [];

  // The standalone-brain endpoints carry their own bearer auth (agents and
  // import/export tools are not browser users), so they skip the viewer's
  // password/proxy gate — but ONLY that gate. They must fall THROUGH to the
  // limiter: an early `return NextResponse.next()` here made their four LIMITS
  // entries dead code and /api/mcp answered 700 requests a minute unthrottled.
  if (BRAIN_ROUTES.has(scope)) {
    // parseBearer, not a second regex: the bytes this keys on and the bytes the
    // route compares have to be the same bytes.
    const token = parseBearer(authorization);
    if (token && grantFor(authorization)) ids.push(`t:${await tokenId(token)}`);
    else denial = json("auth required", 401, { "WWW-Authenticate": "Bearer" });
  } else {
    const r = await checkAuth(req.headers);
    if (!r.ok) {
      denial = json(
        r.detail ?? (r.status === 401 ? "auth required" : "forbidden"),
        r.status ?? 403,
        r.wwwAuthenticate ? { "WWW-Authenticate": "Basic" } : {},
      );
    }
  }

  if (denial) {
    // A LIMITER MAY NEVER STAND BETWEEN A HUMAN AND THE LOGIN PROMPT. The first
    // version of this branch charged EVERY rejected caller and then let the 429
    // replace the denial — and on a bare origin, where every unauthenticated
    // caller is `bad:anon`, 600 credential-less GETs to `/` exhausted that one
    // bucket and the next honest visitor got a 429 with NO `WWW-Authenticate`
    // header. A browser only prompts on a 401 that carries it, so the owner could
    // not log in to their own console: the same owner-lockout this whole change
    // set out to close, moved from the `ip:` bucket to the `bad:` one. That is the
    // rule being enforced at the wrong moment — the challenge is not the attack,
    // it is the answer an honest caller needs.
    //
    // So the viewer gate's denial is delivered unconditionally, exactly as it was
    // before this change. It is the same judgement `/api/health` already gets one
    // screen up: a 429'd healthcheck turns a flood into a restart loop, and a
    // 429'd challenge turns one into a lockout. Both are worse than the flood.
    //
    // A BRAIN route's denial is different and stays limited: no human is prompted
    // by it, a valid credential is keyed under `t:` and cannot be crowded out of
    // it, and an agent that just retries forever is precisely what wants bounding.
    // TWO RESIDUALS, both measured, neither hidden:
    //   - Two credential-less callers on one address share `bad:<addr>`, so one
    //     can turn the other's 401 into a 429. Neither holds a credential, so no
    //     legitimate party loses anything it could have had.
    //   - On a BARE origin the key is `bad:anon` unless the caller supplies
    //     x-forwarded-for — which clientAddr reads unconditionally as a fallback,
    //     so there a rejected caller CAN mint a fresh bucket per request by
    //     rotating that header. An earlier draft of this comment claimed the
    //     opposite ("nothing it presented is part of the key"); it was wrong, and
    //     an adversarial pass showed 700 rotated 401s going unlimited. What it
    //     buys is 401s, which were free before this change too, so the posture is
    //     unchanged rather than worsened — bounding it needs the trusted-hop
    //     count clientAddr's own note already asks for, not more header sniffing.
    if (!BRAIN_ROUTES.has(scope)) return denial;
    ids.length = 0;
    ids.push(`bad:${addr ?? "anon"}`);
  } else {
    // Charge the observed address as well, so rotating the credential cannot buy
    // a second bucket. Everything behind one NAT shares this bucket; the limits
    // above are sized for that. Only PROVED callers are charged here, which is
    // what keeps a flood of bad credentials out of it.
    // ponytail: a BARE origin (nothing proxying in front) stamps no address, so
    // a valid-credential holder there is limited only by its `t:` bucket. Since
    // there are exactly two brain credentials, that is a bounded number of
    // buckets rather than one per request; bounding it further needs a
    // trusted-hop count in config, not more header sniffing.
    if (addr || ids.length === 0) ids.push(`ip:${addr ?? "anon"}`);
  }

  const rule = LIMITS[scope] ?? UNMATCHED;
  const now = Date.now();
  // Charge every bucket before deciding: short-circuiting would leave the second
  // one uncounted, so alternating between them would double the allowance.
  if (ids.map((id) => overLimit(`${scope}|${id}`, rule, now)).some(Boolean)) {
    return json("rate limit exceeded", 429);
  }

  return denial ?? NextResponse.next();
}
