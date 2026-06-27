import { AdminNotAllowedError, adminEnabled, adminFetchChart } from "@/lib/admin";
import { NextResponse } from "next/server";

// Calibration chart SVGs. Fail-closed + chart-type allowlisted in adminFetchChart
// (no arbitrary SVG passthrough). Returns image/svg+xml on success.
export async function GET(_req: Request, ctx: { params: Promise<{ type: string }> }) {
  const g = adminEnabled();
  if (!g.ok) return NextResponse.json({ detail: g.reason ?? "admin disabled" }, { status: 403 });
  const { type } = await ctx.params;
  try {
    const svg = await adminFetchChart(type);
    return new NextResponse(svg, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" },
    });
  } catch (e) {
    if (e instanceof AdminNotAllowedError)
      return NextResponse.json({ detail: e.message }, { status: 404 });
    return NextResponse.json({ detail: "admin chart error" }, { status: 502 });
  }
}
