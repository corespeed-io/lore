import { type NextRequest, NextResponse } from "next/server";
import { checkAuth } from "./src/lib/auth";

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"] };

const OPERATIONAL_PROBE_PATHS = new Set(["/api/health", "/livez", "/readyz"]);

export function isOperationalProbePath(path: string): boolean {
  return OPERATIONAL_PROBE_PATHS.has(path);
}

function json(error: string, status: number, extra: Record<string, string> = {}) {
  const code = status === 401 ? "authentication_required" : "access_denied";
  return new NextResponse(JSON.stringify({ code, error }), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  // Orchestrators must be able to distinguish a live process from a ready
  // instance before application authentication is available. These handlers
  // return operational state only and never install an Actor or expose tenant
  // data. An outer network policy may still restrict them in production.
  if (isOperationalProbePath(path)) return NextResponse.next();

  const authorization = req.headers.get("authorization") ?? "";
  const agentRequest =
    path.startsWith("/api/") && /^Bearer lore_agent_[0-9a-f]{64}$/.test(authorization);
  if (!agentRequest) {
    const r = await checkAuth(req.headers, req.cookies);
    if (!r.ok) {
      return json(
        r.detail ?? (r.status === 401 ? "auth required" : "forbidden"),
        r.status ?? 403,
        r.wwwAuthenticate ? { "WWW-Authenticate": "Basic" } : {},
      );
    }
  }

  return NextResponse.next();
}
