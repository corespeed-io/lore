import type { MemoryModuleOptions, PostgresDatabase } from "@corespeed/lore-core";
import { createMemoryModule } from "@corespeed/lore-core";
import { createRequestContextResolver } from "@/server/auth/request-context";
import { errorResponse } from "@/server/http/errors";
import {
  BadRequestError,
  idempotencyRequest,
  jsonObject,
  optionalTimestamp,
  PreconditionRequiredError,
  parseMemoryInput,
  queryInteger,
  requiredString,
  uuidString,
} from "@/server/http/input";
import { observeOperation } from "@/server/telemetry/telemetry";
import { memoryScope, metadataFilter } from "./input";
import { CreateMemoryInputSchema, UpdateMemoryInputSchema } from "./schemas";

export function memoryEtag(version: number): string {
  return `"memory-v${version}"`;
}

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

interface MemoryCursor {
  id: string;
  updatedAt: string;
}

export function encodeCursor(cursor: MemoryCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeCursor(value: string | null): MemoryCursor | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new BadRequestError("cursor is invalid");
  }
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(atob(normalized + padding)) as Record<string, unknown>;
    const id = uuidString(parsed.id, "cursor.id");
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    if (!updatedAt || updatedAt.length > 64 || !Number.isFinite(new Date(updatedAt).getTime())) {
      throw new BadRequestError("cursor.updatedAt must be an ISO 8601 timestamp");
    }
    return { id, updatedAt };
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
    throw new BadRequestError("cursor is invalid");
  }
}

export function createMemoryHandlers(
  database: PostgresDatabase,
  options: MemoryModuleOptions = {},
) {
  const memories = createMemoryModule(database, options);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
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
        const updatedAfter = optionalTimestamp(
          url.searchParams.get("updated_after"),
          "updated_after",
        );
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
          return Response.json(
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
            { headers: { "cache-control": "private, no-store" } },
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
          headers.set(
            "x-lore-next-cursor",
            encodeCursor({ id: last.id, updatedAt: last.updatedAt }),
          );
        }
        return Response.json(listed, { headers });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const body = await jsonObject(request);
        const input = parseMemoryInput(CreateMemoryInputSchema, body);
        const memory = await observeOperation("memory.create", async () =>
          memories.remember(actor, input, {
            idempotency: await idempotencyRequest(request, "memory.create", input),
          }),
        );
        return Response.json(memory, {
          status: 201,
          headers: { etag: memoryEtag(memory.version), "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createMemoryByIdHandlers(
  database: PostgresDatabase,
  options: MemoryModuleOptions = {},
) {
  const memories = createMemoryModule(database, options);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request, id: string): Promise<Response> {
      try {
        const memoryId = uuidString(id, "memoryId");
        const actor = await resolver.resolveActor(request);
        const memory = await observeOperation("memory.retrieve", () =>
          memories.retrieve(actor, memoryId),
        );
        return memory
          ? Response.json(memory, {
              headers: { etag: memoryEtag(memory.version), "cache-control": "private, no-store" },
            })
          : Response.json({ code: "not_found", error: "Memory not found" }, { status: 404 });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async PATCH(request: Request, id: string): Promise<Response> {
      try {
        const memoryId = uuidString(id, "memoryId");
        const actor = await resolver.resolveActor(request);
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
          ? Response.json(memory, {
              headers: { etag: memoryEtag(memory.version), "cache-control": "private, no-store" },
            })
          : Response.json({ code: "not_found", error: "Memory not found" }, { status: 404 });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async DELETE(request: Request, id: string): Promise<Response> {
      try {
        const memoryId = uuidString(id, "memoryId");
        const actor = await resolver.resolveActor(request);
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
          ? new Response(null, { status: 204 })
          : Response.json({ code: "not_found", error: "Memory not found" }, { status: 404 });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
