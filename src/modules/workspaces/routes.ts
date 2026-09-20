import { Hono } from "hono";
import type { ApiEnv } from "@/server/api/dependencies";
import { jsonObject, requiredString, requireHumanActor } from "@/server/api/input";
import { createAccessModule } from "@/server/auth/access";

export const workspaces = new Hono<ApiEnv>()
  .get("/", async (c) => {
    const access = createAccessModule(await c.var.database());
    const user = await c.var.resolveUser();
    return c.json(await access.listWorkspaces(user));
  })
  .post("/", async (c) => {
    const access = createAccessModule(await c.var.database());
    const request = c.req.raw;
    const user = await c.var.resolveUser();
    const body = await jsonObject(request);
    const workspace = await access.createWorkspace(user, {
      name: requiredString(body.name, "name", 120),
    });
    return c.json(workspace, 201);
  });

/** The verified human Actor inside the active Workspace, not the Identity aggregate. */
export const actor = new Hono<ApiEnv>().get("/", async (c) => {
  const resolved = requireHumanActor(await c.var.resolveActor());
  return c.json({ kind: "human", userId: resolved.userId });
});
