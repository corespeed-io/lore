import type { PostgresDatabase } from "@corespeed/lore-core";
import {
  MemoryAccessDeniedError,
  type MemoryModuleOptions,
  type MemoryScope,
} from "@corespeed/lore-core";
import { CodeEvidenceAccessDeniedError, CodeEvidenceValidationError } from "./code-evidence";
import { CodeIndexAccessDeniedError, CodeIndexValidationError } from "./code-index-errors";
import {
  type ContextRetrievalRoute,
  ContextRetrievalValidationError,
  createContextRetrievalModule,
} from "./context-retrieval";
import {
  createRequestContextResolver,
  RequestAuthenticationError,
  RequestInputError,
  WorkspaceAccessError,
} from "./request-context";
import { observeOperation } from "./telemetry";

class ContextHttpBadRequestError extends Error {
  readonly status = 400;
}

function errorResponse(error: unknown): Response {
  if (
    error instanceof ContextHttpBadRequestError ||
    error instanceof ContextRetrievalValidationError ||
    error instanceof RequestInputError ||
    error instanceof CodeIndexValidationError ||
    error instanceof CodeEvidenceValidationError
  ) {
    return Response.json(
      { code: "invalid_request", error: error.message },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
  if (error instanceof RequestAuthenticationError) {
    return Response.json(
      { code: "authentication_required", error: error.message },
      { status: error.status, headers: { "cache-control": "private, no-store" } },
    );
  }
  if (
    error instanceof WorkspaceAccessError ||
    error instanceof MemoryAccessDeniedError ||
    error instanceof CodeIndexAccessDeniedError ||
    error instanceof CodeEvidenceAccessDeniedError
  ) {
    return Response.json(
      { code: "access_denied", error: error.message },
      { status: 403, headers: { "cache-control": "private, no-store" } },
    );
  }
  console.error("Unhandled Lore Context request error", error);
  return Response.json(
    { code: "internal_error", error: "Internal server error" },
    { status: 500, headers: { "cache-control": "private, no-store" } },
  );
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = (await request.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ContextHttpBadRequestError("Request body must be a JSON object");
  }
}

function requiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") throw new ContextHttpBadRequestError(`${name} is required`);
  return value;
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ContextHttpBadRequestError(`${name} must be a string`);
  return value;
}

function optionalInteger(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new ContextHttpBadRequestError(`${name} must be an integer`);
  }
  return value as number;
}

function optionalRoute(body: Record<string, unknown>): ContextRetrievalRoute | undefined {
  const value = body.route;
  if (value === undefined) return undefined;
  if (!(["auto", "both", "code-only", "memory-only"] as const).includes(value as never)) {
    throw new ContextHttpBadRequestError("route is invalid");
  }
  return value as ContextRetrievalRoute;
}

function optionalScope(body: Record<string, unknown>): MemoryScope | undefined {
  const value = body.scope;
  if (value === undefined) return undefined;
  if (value !== "shared" && value !== "private") {
    throw new ContextHttpBadRequestError("scope must be shared or private");
  }
  return value;
}

function optionalMetadata(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = body.metadata;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextHttpBadRequestError("metadata must be an object");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ContextHttpBadRequestError("metadata must be JSON serializable");
  }
  if (serialized.length > 100_000 || serialized.includes("\\u0000")) {
    throw new ContextHttpBadRequestError("metadata is invalid");
  }
  return value as Record<string, unknown>;
}

export function createContextRetrievalHandlers(
  database: PostgresDatabase,
  memoryOptions: MemoryModuleOptions = {},
) {
  const context = createContextRetrievalModule(database, memoryOptions);
  const resolver = createRequestContextResolver(database);
  return {
    async POST(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
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
        return Response.json(result, {
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
