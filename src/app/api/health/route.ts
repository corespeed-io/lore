import { livenessReport } from "@/modules/operations/service";

export function GET() {
  return Response.json(
    { ...livenessReport(), deprecated: "Use /livez and /readyz" },
    {
      headers: { "cache-control": "no-store" },
    },
  );
}
