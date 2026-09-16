import { loreOpenApiDocument } from "@/server/openapi/document";

export const dynamic = "force-static";

export function GET() {
  return Response.json(loreOpenApiDocument(), {
    headers: { "cache-control": "public, max-age=3600" },
  });
}
