import { Hono } from "hono";
import type { ApiEnv } from "@/server/api/dependencies";
import { BadRequestError, jsonObject } from "@/server/api/input";
import { observeOperation } from "@/server/telemetry/telemetry";
import type { ImportWorkspaceArchive } from "./service";
import {
  createPortabilityModule,
  MAX_WORKSPACE_IMPORT_BODY_BYTES,
  PortabilityAccessDeniedError,
} from "./service";

export const portability = new Hono<ApiEnv>()
  .get("/export", async (c) => {
    const portability = createPortabilityModule(await c.var.database());
    const actor = await c.var.resolveActor();
    const archive = await observeOperation("portability.export", () =>
      portability.exportWorkspace(actor),
    );
    return c.json(archive, {
      headers: {
        "content-disposition": `attachment; filename="lore-workspace-${actor.workspaceId}.json"`,
      },
    });
  })
  .post("/import", async (c) => {
    const portability = createPortabilityModule(await c.var.database(), c.var.memoryOptions());
    const actor = await c.var.resolveActor();
    // Refuse an Agent before reading up to 50 MB of a body the service would reject.
    if (actor.agentId) throw new PortabilityAccessDeniedError("Workspace import requires a User");
    // The byte bound applies while the body streams, before JSON parsing allocates it.
    const body = await jsonObject(c.req.raw, MAX_WORKSPACE_IMPORT_BODY_BYTES);
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
    return c.json(result);
  });
