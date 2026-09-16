import type { PostgresDatabase } from "@corespeed/lore-core";
import { createMemoryGraphModule } from "@/modules/graph/service";
import { createRequestContextResolver } from "@/server/auth/request-context";
import { errorResponse } from "@/server/http/errors";
import { observeOperation } from "@/server/telemetry/telemetry";

export function createGraphHandlers(database: PostgresDatabase) {
  const graph = createMemoryGraphModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const url = new URL(request.url);
        const requestedLimit = Number(url.searchParams.get("limit") ?? "5000");
        const limit = Number.isFinite(requestedLimit) ? requestedLimit : 5000;
        return Response.json(
          await observeOperation("graph.read", () => graph.read(actor, { limit })),
          {
            headers: { "cache-control": "private, no-store" },
          },
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
