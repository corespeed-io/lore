import type { PostgresDatabase } from "@corespeed/lore-core";
import { createRequestContextResolver } from "@/server/auth/request-context";
import { errorResponse } from "@/server/http/errors";
import type { OperationsOptions } from "./service";
import { createOperationsModule } from "./service";

export function createCapabilitiesHandlers(
  database: PostgresDatabase,
  options: { embeddingConfigured: boolean },
) {
  const operations = createOperationsModule(database, options);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        await resolver.resolveActor(request);
        return Response.json(await operations.capabilities(), {
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createReadinessHandlers(database: PostgresDatabase, options: OperationsOptions) {
  const operations = createOperationsModule(database, options);
  return {
    async GET(): Promise<Response> {
      const report = await operations.readiness();
      return Response.json(report, {
        status: report.status === "unready" ? 503 : 200,
        headers: { "cache-control": "no-store" },
      });
    },
  };
}
