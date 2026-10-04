import { Hono } from "hono";
import type { ApiEnv } from "@/server/api/dependencies";
import { BadRequestError, jsonObject } from "@/server/api/input";
import { memoryScope, metadata } from "@/server/api/shared-schemas";
import { observeOperation } from "@/server/telemetry/telemetry";
import { CONTEXT_RETRIEVAL_ROUTES, type ContextRetrievalRoute } from "./policy";
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
  if (!CONTEXT_RETRIEVAL_ROUTES.includes(value as ContextRetrievalRoute)) {
    throw new BadRequestError("route is invalid");
  }
  return value as ContextRetrievalRoute;
}

export const context = new Hono<ApiEnv>().post("/retrieve", async (c) => {
  const context = createContextRetrievalModule(await c.var.database(), c.var.memoryOptions());
  const request = c.req.raw;
  const actor = await c.var.requestActor();
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
      scope: memoryScope(body.scope),
      metadata: metadata(body.metadata),
      pathPrefix: optionalString(body, "pathPrefix"),
    }),
  );
  return c.json(result);
});
