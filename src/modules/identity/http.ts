import type { PostgresDatabase } from "@corespeed/lore-core";
import { createRequestContextResolver } from "@/server/auth/request-context";
import { errorResponse } from "@/server/http/errors";
import { requireHumanActor } from "@/server/http/input";

export function createActorHandlers(database: PostgresDatabase) {
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const actor = requireHumanActor(await resolver.resolveActor(request));
        return Response.json(
          { kind: "human", userId: actor.userId },
          { headers: { "cache-control": "private, no-store" } },
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
