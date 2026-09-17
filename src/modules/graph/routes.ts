import { Hono } from "hono";
import { createMemoryGraphModule } from "@/modules/graph/service";
import type { ApiEnv } from "@/server/api/dependencies";
import { observeOperation } from "@/server/telemetry/telemetry";

export const graph = new Hono<ApiEnv>().get("/", async (c) => {
  const graph = createMemoryGraphModule(await c.var.database());
  const request = c.req.raw;
  const actor = await c.var.resolveActor();
  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") ?? "5000");
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 5_000;
  return c.json(await observeOperation("graph.read", () => graph.read(actor, { limit })));
});
