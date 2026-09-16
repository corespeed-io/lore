import { createCapabilitiesHandlers } from "@/modules/operations/http";
import { getRuntimeDatabase } from "@/server/database/runtime";
import { getRuntimeEmbeddingProvider } from "@/server/providers/embedding/runtime";

export async function GET(request: Request) {
  return createCapabilitiesHandlers(await getRuntimeDatabase(), {
    embeddingConfigured: Boolean(getRuntimeEmbeddingProvider()),
  }).GET(request);
}
