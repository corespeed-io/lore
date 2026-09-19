import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/server/auth/auth";

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"] };

export async function middleware(request: NextRequest) {
  // APIs enforce admission in Hono. The development-only benchmark stays in Next.
  const path = request.nextUrl.pathname;
  if ((path === "/api" || path.startsWith("/api/")) && !path.startsWith("/api/prototype/")) {
    return NextResponse.next();
  }
  return (await authorizeRequest(request)) ?? NextResponse.next();
}
