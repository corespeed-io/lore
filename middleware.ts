import { type NextRequest, NextResponse } from "next/server";
import { checkAuth } from "./src/lib/auth";

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"] };

function json(error: string, status: number, extra: Record<string, string> = {}) {
  return new NextResponse(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (path === "/api/health") return NextResponse.next();

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
