import { livenessReport } from "@/lib/operations";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(livenessReport(), {
    headers: { "cache-control": "no-store" },
  });
}
