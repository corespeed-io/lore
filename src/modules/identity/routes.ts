import { Hono } from "hono";
import type { ApiEnv } from "@/server/api/dependencies";
import { requireHumanActor } from "@/server/api/input";

export const actor = new Hono<ApiEnv>().get("/", async (c) => {
  const actor = requireHumanActor(await c.var.resolveActor());
  return c.json({ kind: "human", userId: actor.userId });
});
