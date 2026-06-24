import { buildGraph } from "@/lib/graph";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    return NextResponse.json(await buildGraph());
  } catch {
    return NextResponse.json({ detail: "couldn't reach the brain" }, { status: 502 });
  }
}
