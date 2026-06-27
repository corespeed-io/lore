import { ADMIN_ENDPOINTS, adminEnabled, adminFetch, adminPostRejection } from "@/lib/admin";
import { NextResponse } from "next/server";

// Fail-closed: admin must be explicitly enabled, or every action 403s.
function gate(): NextResponse | null {
  const g = adminEnabled();
  return g.ok ? null : NextResponse.json({ detail: g.reason ?? "admin disabled" }, { status: 403 });
}

// CSRF guard for mutating POSTs: JSON content-type + same-origin (see admin.ts).
function postGuard(req: Request): NextResponse | null {
  const rej = adminPostRejection({
    contentType: req.headers.get("content-type"),
    origin: req.headers.get("origin"),
    host: req.headers.get("host"),
  });
  return rej ? NextResponse.json({ detail: rej.detail }, { status: rej.status }) : null;
}

function resolve(path: string[] | undefined, method: "GET" | "POST") {
  const action = path?.[0] ?? "";
  const ep = ADMIN_ENDPOINTS[action];
  return ep && ep.method === method ? action : null;
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const denied = gate();
  if (denied) return denied;
  const action = resolve((await ctx.params).path, "GET");
  if (!action) return NextResponse.json({ detail: "unknown admin action" }, { status: 404 });
  try {
    const args = Object.fromEntries(new URL(req.url).searchParams);
    return NextResponse.json(await adminFetch(action, args));
  } catch {
    return NextResponse.json({ detail: "admin backend error" }, { status: 502 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const denied = gate() ?? postGuard(req);
  if (denied) return denied;
  const action = resolve((await ctx.params).path, "POST");
  if (!action) return NextResponse.json({ detail: "unknown admin action" }, { status: 404 });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(await adminFetch(action, body));
  } catch {
    return NextResponse.json({ detail: "admin backend error" }, { status: 502 });
  }
}
