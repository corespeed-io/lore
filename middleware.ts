import { type NextRequest, NextResponse } from "next/server";
import { checkAuth } from "./src/lib/auth.js";

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };

export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === "/api/health") return NextResponse.next();
  const r = checkAuth(req.headers, req.cookies);
  if (r.ok) return NextResponse.next();
  return new NextResponse(
    JSON.stringify({ detail: r.status === 401 ? "auth required" : "Cloudflare Access required" }),
    {
      status: r.status ?? 403,
      headers: {
        "content-type": "application/json",
        ...(r.wwwAuthenticate ? { "WWW-Authenticate": "Basic" } : {}),
      },
    },
  );
}
