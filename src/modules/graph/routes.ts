import { MEMORY_GRAPH_LIMITS } from "@corespeed/lore-core";
import { Hono } from "hono";
import { z } from "zod/v4";
import { createMemoryGraphModule } from "@/modules/graph/service";
import type { ApiEnv } from "@/server/api/dependencies";
import {
  BadRequestError,
  jsonObject,
  parseMemoryInput,
  queryInteger,
  uuidString,
} from "@/server/api/input";
import { MemoryMetadataSchema } from "@/server/api/shared-schemas";
import { NotFoundError } from "@/server/errors";
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

// The wire shape only; the engine owns the weight and metadata rules. Strict, so a
// kind sent in the body (it belongs in the query) is refused rather than ignored.
const PutMemoryLinkInputSchema = z.strictObject(
  {
    weight: z.number({ error: "weight must be a number" }).optional(),
    metadata: MemoryMetadataSchema.optional(),
  },
  { error: "Memory Link input must be an object with only weight and metadata" },
);

/**
 * The natural key (source, target, kind) of the Link a request addresses. A
 * misspelled or repeated parameter is refused: falling back to the default kind
 * would make a DELETE remove a different Link.
 */
function linkKey(request: Request, sourceId: string, targetId: string) {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some((name) => name !== "kind")) {
    throw new BadRequestError("kind is the only query parameter a Memory Link accepts");
  }
  const kinds = query.getAll("kind");
  if (kinds.length > 1) throw new BadRequestError("kind may be given once");
  // The kind is stored exactly as given, so it is not trimmed here.
  const [kind] = kinds;
  return {
    sourceMemoryId: uuidString(sourceId, "memoryId"),
    targetMemoryId: uuidString(targetId, "targetMemoryId"),
    ...(kind === undefined ? {} : { kind }),
  };
}

// Addressed by natural key, so a repeated PUT or DELETE needs no Idempotency-Key.
export const memoryLinks = new Hono<ApiEnv>()
  .put("/:id/links/:targetId", async (c) => {
    const graph = createMemoryGraphModule(await c.var.database());
    const request = c.req.raw;
    const key = linkKey(request, c.req.param("id"), c.req.param("targetId"));
    const actor = await c.var.resolveActor();
    const input = parseMemoryInput(PutMemoryLinkInputSchema, await jsonObject(request));
    const connected = await observeOperation("memory-link.connect", () =>
      graph.connect(actor, { ...key, ...input }),
    );
    // One answer for a missing, invisible, or unwritable endpoint.
    if (!connected) throw new NotFoundError("Memory not found");
    return c.json(connected.link, connected.created ? 201 : 200);
  })
  .delete("/:id/links/:targetId", async (c) => {
    const graph = createMemoryGraphModule(await c.var.database());
    const key = linkKey(c.req.raw, c.req.param("id"), c.req.param("targetId"));
    const actor = await c.var.resolveActor();
    const deleted = await observeOperation("memory-link.disconnect", () =>
      graph.disconnect(actor, key),
    );
    if (!deleted) throw new NotFoundError("Memory Link not found");
    return c.body(null, 204);
  });
