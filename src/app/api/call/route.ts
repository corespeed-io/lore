import { ToolNotAllowedError, callTool } from "@/lib/tools";
import { clampArgs } from "@/server/mcp";
import { NextResponse } from "next/server";

// The clamp is imported, not restated. Two copies of "how big may a request be"
// is how one of them stayed at 200 while the other moved, and list_pages got
// truncated to 200 rows no matter what the tool allowed.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "bad request" }, { status: 400 });
  }
  const { tool, args } = (body ?? {}) as { tool?: unknown; args?: unknown };
  if (typeof tool !== "string") {
    return NextResponse.json({ detail: "bad request" }, { status: 400 });
  }
  try {
    return NextResponse.json(await callTool(tool, clampArgs(args)));
  } catch (e) {
    if (e instanceof ToolNotAllowedError)
      return NextResponse.json({ detail: e.message }, { status: 403 });
    return NextResponse.json({ detail: "brain error" }, { status: 502 });
  }
}
