import { adminEnabled } from "@/lib/admin";
import { NextResponse } from "next/server";

// Whether admin mode is configured — the ONLY admin signal the client may see.
// Returns just { enabled }; never a reason or any config value (no secret leak).
// Stays 200 even when disabled so the viewer can decide whether to show Admin.
export function GET() {
  return NextResponse.json({ enabled: adminEnabled().ok });
}
