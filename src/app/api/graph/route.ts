import { buildGraph } from "@/lib/graph";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    return NextResponse.json(await buildGraph());
  } catch (err) {
    // The thrown reason (which reads failed, how many) only exists server-side;
    // without this line the 502 is an opaque "couldn't reach the brain".
    console.error("graph build failed:", err);
    return NextResponse.json({ detail: "couldn't reach the brain" }, { status: 502 });
  }
}
