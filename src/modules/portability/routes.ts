import { Hono } from "hono";
import type { ApiEnv } from "@/server/api/dependencies";
import { BadRequestError, jsonObject } from "@/server/api/input";
import { observeOperation } from "@/server/telemetry/telemetry";
import type { ImportWorkspaceArchive } from "./service";
import { createPortabilityModule } from "./service";

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
    const portability = createPortabilityModule(await c.var.database());
    const request = c.req.raw;
    const actor = await c.var.resolveActor();
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
    return c.json(result);
  });
