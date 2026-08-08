import { createOperationsModule } from "@/lib/operations";
import { getRuntimeDatabase } from "@/lib/runtime/database";
import { getRuntimeEmbeddingProvider } from "@/lib/runtime/embedding";

export async function GET() {
  const operations = createOperationsModule(await getRuntimeDatabase(), {
    embeddingConfigured: Boolean(getRuntimeEmbeddingProvider()),
  });
  return Response.json(await operations.capabilities(), {
    headers: { "cache-control": "no-store" },
  });
}
