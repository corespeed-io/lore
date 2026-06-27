import { READ_ONLY_TOOLS } from "@/lib/gbrain";
import { NextResponse } from "next/server";

// The public read boundary: the exact set of gbrain tools Lore is allowed to
// call. Read-only and credential-free — it returns only tool names (already
// public in the source) so the UI can show users what Lore can and can't do.
export function GET() {
  return NextResponse.json({ tools: [...READ_ONLY_TOOLS].sort() });
}
