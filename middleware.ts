import { type NextRequest, NextResponse } from "next/server";
import { checkAuth } from "./src/lib/auth.js";

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };

// Per-instance fixed-window limiter for the gbrain-proxying routes. Each call is
// a 1:1 proxy onto the shared brain, so an authenticated/compromised account
// could otherwise loop to exhaust its quota.
// ponytail: per-isolate in-memory, fine for a single Railway replica; swap for a
// shared store (Redis) if this ever scales horizontally.
const LIMITS: Record<string, { max: number; windowMs: number }> = {
  "/api/call": { max: 120, windowMs: 60_000 },
  "/api/graph": { max: 60, windowMs: 60_000 },
};
const hits = new Map<string, { count: number; resetAt: number }>();
// Cap the map so a stream of one-shot keys (distinct IPs/emails that never
// recur) can't grow it without bound — buckets are only refreshed lazily on a
// repeat hit, so without this they'd never be reclaimed.
const MAX_KEYS = 10_000;

function rateLimited(path: string, who: string, now: number): boolean {
  const rule = LIMITS[path];
  if (!rule) return false;
  if (hits.size > MAX_KEYS) {
    for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
  }
  const key = `${path}|${who}`;
  const cur = hits.get(key);
  if (!cur || now > cur.resetAt) {
    hits.set(key, { count: 1, resetAt: now + rule.windowMs });
    return false;
  }
  cur.count += 1;
  return cur.count > rule.max;
}

function json(detail: string, status: number, extra: Record<string, string> = {}) {
  return new NextResponse(JSON.stringify({ detail }), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (path === "/api/health") return NextResponse.next();

  const r = await checkAuth(req.headers, req.cookies);
  if (!r.ok) {
    return json(
      r.detail ?? (r.status === 401 ? "auth required" : "forbidden"),
      r.status ?? 403,
      r.wwwAuthenticate ? { "WWW-Authenticate": "Basic" } : {},
    );
  }

  const who =
    req.headers.get("cf-access-authenticated-user-email") ||
    req.headers.get("cf-connecting-ip") ||
    "anon";
  if (rateLimited(path, who, Date.now())) return json("rate limit exceeded", 429);

  return NextResponse.next();
}
