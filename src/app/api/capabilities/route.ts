import { createCapabilitiesHandlers } from "@/lib/http";
import { getRuntimeDatabase } from "@/lib/runtime/database";
import { getRuntimeEmbeddingProvider } from "@/lib/runtime/embedding";

export async function GET(request: Request) {
  return createCapabilitiesHandlers(await getRuntimeDatabase(), {
    embeddingConfigured: Boolean(getRuntimeEmbeddingProvider()),
  }).GET(request);
}
