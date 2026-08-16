import {
  CodeEvidenceAccessDeniedError,
  type CodeEvidenceRelationship,
  CodeEvidenceValidationError,
  createCodeEvidenceModule,
} from "./code-evidence";
import { type CodeDependencyDirection, createCodeDependencyGraphModule } from "./code-graph";
import { CodeIndexAccessDeniedError, CodeIndexValidationError } from "./code-index-errors";
import { type ConfiguredCodeRepositories, createCodeIndexQueueModule } from "./code-index-queue";
import { createCodeIndexReadModule } from "./code-index-read";
import type { PostgresDatabase } from "./db";
import {
  createRequestContextResolver,
  RequestAuthenticationError,
  RequestInputError,
  WorkspaceAccessError,
} from "./request-context";
import { observeOperation } from "./telemetry";

class CodeHttpBadRequestError extends Error {
  readonly status = 400;
}

function errorResponse(error: unknown): Response {
  if (
    error instanceof CodeHttpBadRequestError ||
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
    error instanceof CodeIndexAccessDeniedError ||
    error instanceof CodeEvidenceAccessDeniedError
  ) {
    return Response.json(
      { code: "access_denied", error: error.message },
      { status: 403, headers: { "cache-control": "private, no-store" } },
    );
  }
  console.error("Unhandled Lore Code request error", error);
  return Response.json(
    { code: "internal_error", error: "Internal server error" },
    { status: 500, headers: { "cache-control": "private, no-store" } },
  );
}

function requiredQuery(url: URL, name: string, maximumLength: number): string {
  const value = url.searchParams.get(name)?.trim();
  if (!value || value.length > maximumLength) {
    throw new CodeHttpBadRequestError(`${name} is required`);
  }
  return value;
}

function optionalLimit(url: URL): number | undefined {
  const value = url.searchParams.get("limit");
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new CodeHttpBadRequestError("limit must be an integer from 1 through 100");
  }
  return parsed;
}

function optionalDependencyLimit(url: URL): number | undefined {
  const value = url.searchParams.get("limit");
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new CodeHttpBadRequestError("limit must be an integer from 1 through 200");
  }
  return parsed;
}

function dependencyDirection(url: URL): CodeDependencyDirection {
  const value = requiredQuery(url, "direction", 16);
  if (value !== "callers" && value !== "callees") {
    throw new CodeHttpBadRequestError("direction must be callers or callees");
  }
  return value;
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = (await request.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new CodeHttpBadRequestError("Request body must be a JSON object");
  }
}

function requiredBodyString(
  body: Record<string, unknown>,
  name: string,
  maximumLength: number,
): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    throw new CodeHttpBadRequestError(`${name} is required`);
  }
  return value.trim();
}

export function createCodeSearchHandlers(database: PostgresDatabase) {
  const code = createCodeIndexReadModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const url = new URL(request.url);
        const pathPrefix = url.searchParams.get("path_prefix")?.trim() || undefined;
        const results = await observeOperation("code-index.search", () =>
          code.search(actor, {
            repositoryKey: requiredQuery(url, "repository_key", 512),
            commitOid: requiredQuery(url, "commit_oid", 64),
            query: requiredQuery(url, "q", 2_000),
            limit: optionalLimit(url),
            pathPrefix,
          }),
        );
        return Response.json(results, {
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createCodeDependencyHandlers(database: PostgresDatabase) {
  const graph = createCodeDependencyGraphModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const url = new URL(request.url);
        const symbol = url.searchParams.get("symbol") ?? undefined;
        const path = url.searchParams.get("path") ?? undefined;
        const result = await observeOperation("code-index.dependencies", () =>
          graph.query(actor, {
            repositoryKey: requiredQuery(url, "repository_key", 512),
            commitOid: requiredQuery(url, "commit_oid", 64),
            direction: dependencyDirection(url),
            symbol,
            path,
            limit: optionalDependencyLimit(url),
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

export function createCodeIndexJobByIdHandlers(database: PostgresDatabase) {
  const code = createCodeIndexReadModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request, id: string): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const job = await observeOperation("code-index.job", () =>
          code.getIndexJob(actor, { jobId: id }),
        );
        return Response.json(job, {
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createCodeIndexJobHandlers(
  database: PostgresDatabase,
  repositories: ConfiguredCodeRepositories,
) {
  const queue = createCodeIndexQueueModule(database, repositories);
  const resolver = createRequestContextResolver(database);
  return {
    async POST(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const body = await jsonObject(request);
        const sourceRef = body.sourceRef;
        if (sourceRef !== undefined && typeof sourceRef !== "string") {
          throw new CodeHttpBadRequestError("sourceRef must be a string");
        }
        const job = await observeOperation("code-index.enqueue", () =>
          queue.enqueue(actor, {
            repositoryKey: requiredBodyString(body, "repositoryKey", 512),
            commitOid: requiredBodyString(body, "commitOid", 64),
            ...(typeof sourceRef === "string" ? { sourceRef } : {}),
          }),
        );
        return Response.json(job, {
          status: 202,
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createMemoryCodeEvidenceHandlers(database: PostgresDatabase) {
  const evidence = createCodeEvidenceModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request, memoryId: string): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const result = await observeOperation("code-evidence.list", () =>
          evidence.list(actor, { memoryId }),
        );
        return Response.json(result, {
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async POST(request: Request, memoryId: string): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const body = await jsonObject(request);
        const relationship = requiredBodyString(
          body,
          "relationship",
          32,
        ) as CodeEvidenceRelationship;
        const result = await observeOperation("code-evidence.cite", () =>
          evidence.cite(actor, {
            memoryId,
            artifactId: requiredBodyString(body, "artifactId", 36),
            relationship,
          }),
        );
        return Response.json(result, {
          status: 201,
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createCodeEvidenceByIdHandlers(database: PostgresDatabase) {
  const evidence = createCodeEvidenceModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async POST(request: Request, evidenceId: string): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const body = await jsonObject(request);
        const result = await observeOperation("code-evidence.revalidate", () =>
          evidence.revalidate(actor, {
            evidenceId,
            repositoryKey: requiredBodyString(body, "repositoryKey", 512),
            commitOid: requiredBodyString(body, "commitOid", 64),
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
