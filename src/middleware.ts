import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/server/auth/auth";

// APIs enforce admission in Hono, so the matcher excludes `/api` and `/api/*` except the
// development-only `/api/prototype/*` benchmark, which stays in Next. Excluding them is
// not only an optimization: Next clones every non-GET body that reaches middleware and
// truncates the copy at `proxyClientMaxBodySize` (10 MB), which broke Workspace import.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|api(?:/(?!prototype/)|$)).*)"],
};

export async function middleware(request: NextRequest) {
  // Defense in depth if the matcher ever widens again: never admit an API twice.
  const path = request.nextUrl.pathname;
  if ((path === "/api" || path.startsWith("/api/")) && !path.startsWith("/api/prototype/")) {
    return NextResponse.next();
  }
  return (await authorizeRequest(request)) ?? NextResponse.next();
}
