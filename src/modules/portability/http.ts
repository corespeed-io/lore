import type { PostgresDatabase } from "@corespeed/lore-core";
import { createRequestContextResolver } from "@/server/auth/request-context";
import { errorResponse } from "@/server/http/errors";
import { BadRequestError, jsonObject } from "@/server/http/input";
import { observeOperation } from "@/server/telemetry/telemetry";
import type { ImportWorkspaceArchive } from "./service";
import { createPortabilityModule } from "./service";

export function createPortabilityHandlers(database: PostgresDatabase) {
  const portability = createPortabilityModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async EXPORT(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const archive = await observeOperation("portability.export", () =>
          portability.exportWorkspace(actor),
        );
        return Response.json(archive, {
          headers: {
            "cache-control": "private, no-store",
            "content-disposition": `attachment; filename="lore-workspace-${actor.workspaceId}.json"`,
          },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async IMPORT(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const body = await jsonObject(request);
        if (JSON.stringify(body).length > 50_000_000) {
          throw new BadRequestError("Workspace archive exceeds 50000000 characters");
        }
        const archive = body.archive;
        const ownerMap = body.ownerMap;
        if (!archive || typeof archive !== "object" || Array.isArray(archive)) {
          throw new BadRequestError("archive must be an object");
        }
        if (!ownerMap || typeof ownerMap !== "object" || Array.isArray(ownerMap)) {
          throw new BadRequestError("ownerMap must be an object");
        }
        const result = await observeOperation("portability.import", () =>
          portability.importWorkspace(actor, {
            archive,
            ownerMap,
            conflictPolicy: body.conflictPolicy,
            dryRun: body.dryRun === true,
          } as ImportWorkspaceArchive),
        );
        return Response.json(result, {
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
