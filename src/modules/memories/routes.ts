import { Hono } from "hono";
import { createMemoryModule } from "@/modules/memories/service";
import type { ApiEnv } from "@/server/api/dependencies";
import {
  BadRequestError,
  decodeCursor,
  encodeCursor,
  idempotencyRequest,
  jsonObject,
  optionalTimestamp,
  PreconditionRequiredError,
  parseMemoryInput,
  queryInteger,
  requiredString,
  uuidString,
} from "@/server/api/input";
import { observeOperation } from "@/server/telemetry/telemetry";
import { memoryEtag, memoryScope, metadataFilter } from "./input";
import { CreateMemoryInputSchema, UpdateMemoryInputSchema } from "./schemas";

function expectedMemoryVersion(request: Request): number {
  const value = request.headers.get("if-match")?.trim();
  if (!value) throw new PreconditionRequiredError("If-Match is required for Memory mutation");
  const match = /^"memory-v([1-9][0-9]*)"$/.exec(value);
  if (!match)
    throw new BadRequestError('If-Match must be a strong Memory ETag such as "memory-v2"');
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version))
    throw new BadRequestError("If-Match Memory version is invalid");
  return version;
}

export const memories = new Hono<ApiEnv>()
  .get("/", async (c) => {
    const memories = createMemoryModule(await c.var.database(), c.var.memoryOptions());
    const request = c.req.raw;
    const actor = await c.var.resolveActor();
    const url = new URL(request.url);
    const requestedQuery = url.searchParams.get("q");
    const query = requestedQuery?.trim() ? requiredString(requestedQuery, "q", 10_000) : "";
    const limit = queryInteger(url, "limit", 50, 1, 100);
    const offset = queryInteger(url, "offset", 0, 0, 1_000_000);
    const cursor = decodeCursor(url.searchParams.get("cursor"));
    if (cursor && url.searchParams.has("offset")) {
      throw new BadRequestError("cursor and offset cannot be combined");
    }
    const scope = memoryScope(url.searchParams.get("scope") ?? undefined);
    const updatedAfter = optionalTimestamp(url.searchParams.get("updated_after"), "updated_after");
    const updatedBefore = optionalTimestamp(
      url.searchParams.get("updated_before"),
      "updated_before",
    );
    const requestedMetadata = metadataFilter(url.searchParams.get("metadata"));
    if (
      updatedAfter &&
      updatedBefore &&
      new Date(updatedAfter).getTime() >= new Date(updatedBefore).getTime()
    ) {
      throw new BadRequestError("updated_after must be earlier than updated_before");
    }
    if (query) {
      return c.json(
        await observeOperation("memory.search", () =>
          memories.search(actor, {
            query,
            limit,
            metadataFilter: requestedMetadata,
            scope,
            updatedAfter,
            updatedBefore,
          }),
        ),
      );
    }
    const listed = await observeOperation("memory.list", () =>
      memories.list(actor, {
        cursor,
        limit,
        offset,
        metadataFilter: requestedMetadata,
        scope,
        updatedAfter,
        updatedBefore,
      }),
    );
    const last = listed.length === limit ? listed.at(-1) : undefined;
    const headers = new Headers({ "cache-control": "private, no-store" });
    if (last) {
      headers.set("x-lore-next-cursor", encodeCursor({ id: last.id, updatedAt: last.updatedAt }));
    }
    return c.json(listed, { headers });
  })
  .post("/", async (c) => {
    const memories = createMemoryModule(await c.var.database(), c.var.memoryOptions());
    const request = c.req.raw;
    const actor = await c.var.resolveActor();
    const body = await jsonObject(request);
    const input = parseMemoryInput(CreateMemoryInputSchema, body);
    const memory = await observeOperation("memory.create", async () =>
      memories.remember(actor, input, {
        idempotency: await idempotencyRequest(request, "memory.create", input),
      }),
    );
    return c.json(memory, { status: 201, headers: { etag: memoryEtag(memory.version) } });
  })
  .get("/:id", async (c) => {
    const memories = createMemoryModule(await c.var.database());
    const id = c.req.param("id");
    const memoryId = uuidString(id, "memoryId");
    const actor = await c.var.resolveActor();
    const memory = await observeOperation("memory.retrieve", () =>
      memories.retrieve(actor, memoryId),
    );
    return memory
      ? c.json(memory, { headers: { etag: memoryEtag(memory.version) } })
      : c.json({ code: "not_found", error: "Memory not found" }, 404);
  })
  .patch("/:id", async (c) => {
    const memories = createMemoryModule(await c.var.database(), c.var.memoryOptions());
    const request = c.req.raw;
    const id = c.req.param("id");
    const memoryId = uuidString(id, "memoryId");
    const actor = await c.var.resolveActor();
    const body = await jsonObject(request);
    const input = parseMemoryInput(UpdateMemoryInputSchema, body);
    const expectedVersion = expectedMemoryVersion(request);
    const memory = await observeOperation("memory.update", async () =>
      memories.update(actor, memoryId, input, {
        expectedVersion,
        idempotency: await idempotencyRequest(request, "memory.update", {
          id: memoryId,
          expectedVersion,
          input,
        }),
      }),
    );
    return memory
      ? c.json(memory, { headers: { etag: memoryEtag(memory.version) } })
      : c.json({ code: "not_found", error: "Memory not found" }, 404);
  })
  .delete("/:id", async (c) => {
    const memories = createMemoryModule(await c.var.database());
    const request = c.req.raw;
    const id = c.req.param("id");
    const memoryId = uuidString(id, "memoryId");
    const actor = await c.var.resolveActor();
    const expectedVersion = expectedMemoryVersion(request);
    const forgotten = await observeOperation("memory.delete", async () =>
      memories.forget(actor, memoryId, {
        expectedVersion,
        idempotency: await idempotencyRequest(request, "memory.delete", {
          id: memoryId,
          expectedVersion,
        }),
      }),
    );
    return forgotten
      ? c.body(null, 204)
      : c.json({ code: "not_found", error: "Memory not found" }, 404);
  });
