import { grantFor } from "@/server/auth-bearer";
// The standalone brain's MCP endpoint — how agents read AND write this brain
// over Streamable HTTP (stateless JSON responses). Auth is its own bearer pair
// (BRAIN_WRITE_TOKEN / BRAIN_READ_TOKEN), fail-closed when neither is set;
// middleware exempts this path from viewer auth for exactly that reason.
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { resolveDatabaseUrl } = await import("@/server/drivers");
  if (!(await resolveDatabaseUrl())) {
    return NextResponse.json({ detail: "standalone brain not configured" }, { status: 404 });
  }
  const access = grantFor(req.headers.get("authorization"));
  if (!access) {
    return NextResponse.json(
      { detail: "auth required" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "bad request" }, { status: 400 });
  }
  const { id, method, params } = (body ?? {}) as {
    id?: unknown;
    method?: unknown;
    params?: Record<string, unknown>;
  };
  if (typeof method !== "string") {
    return NextResponse.json({ detail: "bad request" }, { status: 400 });
  }

  const { handleRpc } = await import("@/server/mcp");
  const { getStore } = await import("@/server/local");
  try {
    const rpc = await handleRpc(getStore, access, method, params);
    if (rpc.notification) return new NextResponse(null, { status: 202 });
    if (rpc.error) {
      return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: rpc.error });
    }
    return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result: rpc.result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json(
      { jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message } },
      { status: 500 },
    );
  }
}

// Streamable HTTP allows servers to decline the SSE channel.
export function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
