import { ToolNotAllowedError, callTool } from "@/lib/gbrain";
import { NextResponse } from "next/server";

const MAX = 200;
const BOUNDED = ["limit", "depth", "max", "top_k", "k"];

// The allowlist gates the tool *name*; args are caller-controlled. Clamp the
// common unbounded knobs so a client can't ask gbrain for a million rows.
function clampArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null) return {};
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const k of BOUNDED) {
    if (typeof out[k] === "number" && out[k] > MAX) out[k] = MAX;
  }
  return out;
}

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
