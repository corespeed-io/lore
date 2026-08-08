import { createOperationsModule } from "@/lib/operations";
import { getRuntimeDatabase } from "@/lib/runtime/database";
import { getRuntimeEmbeddingProvider } from "@/lib/runtime/embedding";

export const dynamic = "force-dynamic";

export async function GET() {
  // Initializing the provider records invalid configuration as degraded. Lore v1
  // always has a deployment-level embedding space (with local Ollama defaults),
  // so failure to construct it is not the same as an intentional disabled mode.
  getRuntimeEmbeddingProvider();
  const operations = createOperationsModule(await getRuntimeDatabase(), {
    embeddingConfigured: true,
  });
  const report = await operations.readiness();
  return Response.json(report, {
    status: report.status === "unready" ? 503 : 200,
    headers: { "cache-control": "no-store" },
  });
}
