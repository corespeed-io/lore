import { livenessReport } from "@/modules/operations/service";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(livenessReport(), {
    headers: { "cache-control": "no-store" },
  });
}
