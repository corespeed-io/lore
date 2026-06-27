import { READ_ONLY_TOOLS } from "@/lib/gbrain";
import { NextResponse } from "next/server";

// Diagnostic endpoint for the server-side viewer allowlist. The product UI
// should not surface this as a dashboard card.
export async function GET() {
  return NextResponse.json({ tools: [...READ_ONLY_TOOLS].sort() });
}
