import { ToolNotAllowedError, callTool } from "@/lib/gbrain";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { tool, args } = await req.json();
  try {
    return NextResponse.json(await callTool(tool, args ?? {}));
  } catch (e) {
    if (e instanceof ToolNotAllowedError)
      return NextResponse.json({ detail: e.message }, { status: 403 });
    return NextResponse.json({ detail: "brain error" }, { status: 502 });
  }
}
