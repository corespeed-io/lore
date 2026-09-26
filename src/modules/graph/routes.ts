import { MEMORY_GRAPH_LIMITS } from "@corespeed/lore-core";
import { Hono } from "hono";
import { createMemoryGraphModule } from "@/modules/graph/service";
import type { ApiEnv } from "@/server/api/dependencies";
import { queryInteger } from "@/server/api/input";
import { observeOperation } from "@/server/telemetry/telemetry";

export const graph = new Hono<ApiEnv>().get("/", async (c) => {
  const graph = createMemoryGraphModule(await c.var.database());
  const request = c.req.raw;
  const actor = await c.var.resolveActor();
  const url = new URL(request.url);
  const limit = queryInteger(
    url,
    "limit",
    MEMORY_GRAPH_LIMITS.maximumNodes,
    1,
    MEMORY_GRAPH_LIMITS.maximumNodes,
  );
  return c.json(await observeOperation("graph.read", () => graph.read(actor, { limit })));
});
