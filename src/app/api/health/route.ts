import { livenessReport } from "@/lib/operations";

export function GET() {
  return Response.json(
    { ...livenessReport(), deprecated: "Use /livez and /readyz" },
    {
      headers: { "cache-control": "no-store" },
    },
  );
}
