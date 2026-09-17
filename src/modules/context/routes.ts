import type { MemoryScope } from "@corespeed/lore-core";
import { Hono } from "hono";
import type { ApiEnv } from "@/server/api/dependencies";
import { BadRequestError, jsonObject } from "@/server/api/input";
import { observeOperation } from "@/server/telemetry/telemetry";
import type { ContextRetrievalRoute } from "./retrieval";
import { createContextRetrievalModule } from "./retrieval";

function requiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") throw new BadRequestError(`${name} is required`);
  return value;
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new BadRequestError(`${name} must be a string`);
  return value;
}

function optionalInteger(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new BadRequestError(`${name} must be an integer`);
  }
  return value as number;
}

function optionalRoute(body: Record<string, unknown>): ContextRetrievalRoute | undefined {
  const value = body.route;
  if (value === undefined) return undefined;
  if (!(["auto", "both", "code-only", "memory-only"] as const).includes(value as never)) {
    throw new BadRequestError("route is invalid");
  }
  return value as ContextRetrievalRoute;
}

function optionalScope(body: Record<string, unknown>): MemoryScope | undefined {
  const value = body.scope;
  if (value === undefined) return undefined;
  if (value !== "shared" && value !== "private") {
    throw new BadRequestError("scope must be shared or private");
  }
  return value;
}

function optionalMetadata(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = body.metadata;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("metadata must be an object");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new BadRequestError("metadata must be JSON serializable");
  }
  if (serialized.length > 100_000 || serialized.includes("\\u0000")) {
    throw new BadRequestError("metadata is invalid");
  }
  return value as Record<string, unknown>;
}

export const context = new Hono<ApiEnv>().post("/retrieve", async (c) => {
  const context = createContextRetrievalModule(await c.var.database(), c.var.memoryOptions());
  const request = c.req.raw;
  const actor = await c.var.resolveActor();
  const body = await jsonObject(request);
  const result = await observeOperation("context.retrieve", () =>
    context.retrieve(actor, {
      query: requiredString(body, "query"),
      memoryQuery: optionalString(body, "memoryQuery"),
      codeQuery: optionalString(body, "codeQuery"),
      repositoryKey: optionalString(body, "repositoryKey"),
      commitOid: optionalString(body, "commitOid"),
      route: optionalRoute(body),
      memoryLimit: optionalInteger(body, "memoryLimit"),
      codeLimit: optionalInteger(body, "codeLimit"),
      scope: optionalScope(body),
      metadata: optionalMetadata(body),
      pathPrefix: optionalString(body, "pathPrefix"),
    }),
  );
  return c.json(result);
});
