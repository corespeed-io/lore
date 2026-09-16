import type { PostgresDatabase } from "@corespeed/lore-core";
import { createAccessModule } from "@/server/auth/access";
import { createRequestContextResolver } from "@/server/auth/request-context";
import { errorResponse } from "@/server/http/errors";
import { jsonObject, requiredString } from "@/server/http/input";

export function createWorkspaceHandlers(database: PostgresDatabase) {
  const access = createAccessModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const user = await resolver.resolveUser(request);
        return Response.json(await access.listWorkspaces(user));
      } catch (error) {
        return errorResponse(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      try {
        const user = await resolver.resolveUser(request);
        const body = await jsonObject(request);
        const workspace = await access.createWorkspace(user, {
          name: requiredString(body.name, "name", 120),
        });
        return Response.json(workspace, { status: 201 });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
