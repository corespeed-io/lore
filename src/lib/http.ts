import {
  AccessDeniedError,
  type AgentGrantPermission,
  type AgentStatus,
  createAccessModule,
} from "./access";
import type { ActorContext } from "./actor-context";
import type { PostgresDatabase } from "./db";
import {
  createEvaluationModule,
  type EvaluationCaseInput,
  type EvaluationModuleOptions,
  EvaluationSuiteNotFoundError,
} from "./evaluation";
import { createMemoryGraphModule } from "./graph";
import {
  IdempotencyConflictError,
  type IdempotencyRequest,
  mutationRequestHash,
} from "./idempotency";
import {
  createMemoryModule,
  MemoryAccessDeniedError,
  type MemoryModuleOptions,
  type MemoryScope,
  MemoryVersionConflictError,
} from "./memory";
import { createOperationsModule } from "./operations";
import {
  createPortabilityModule,
  type ImportWorkspaceArchive,
  PortabilityAccessDeniedError,
  PortabilityValidationError,
  WorkspaceExportLimitError,
} from "./portability";
import {
  createRequestContextResolver,
  normalizeUuid,
  RequestAuthenticationError,
  RequestInputError,
  WorkspaceAccessError,
} from "./request-context";
import { observeOperation } from "./telemetry";

class BadRequestError extends Error {
  readonly status = 400;
}

class PreconditionRequiredError extends Error {
  readonly status = 428;
}

function errorCode(error: unknown): string {
  if (error instanceof PreconditionRequiredError) return "precondition_required";
  if (error instanceof MemoryVersionConflictError) return "version_conflict";
  if (error instanceof IdempotencyConflictError) return "idempotency_conflict";
  if (error instanceof WorkspaceExportLimitError) return error.code;
  if (error instanceof BadRequestError || error instanceof RequestInputError)
    return "invalid_request";
  if (error instanceof RequestAuthenticationError) return "authentication_required";
  if (
    error instanceof WorkspaceAccessError ||
    error instanceof AccessDeniedError ||
    error instanceof MemoryAccessDeniedError
  ) {
    return "access_denied";
  }
  if (error instanceof EvaluationSuiteNotFoundError) return "not_found";
  if (error instanceof PortabilityValidationError) return "invalid_archive";
  if (error instanceof PortabilityAccessDeniedError) return "access_denied";
  return "internal_error";
}

function errorResponse(error: unknown): Response {
  if (
    error instanceof BadRequestError ||
    error instanceof RequestInputError ||
    error instanceof RequestAuthenticationError ||
    error instanceof WorkspaceAccessError ||
    error instanceof PreconditionRequiredError ||
    error instanceof MemoryVersionConflictError ||
    error instanceof IdempotencyConflictError ||
    error instanceof PortabilityValidationError ||
    error instanceof PortabilityAccessDeniedError ||
    error instanceof WorkspaceExportLimitError
  ) {
    return Response.json(
      { code: errorCode(error), error: error.message },
      { status: error.status, headers: { "cache-control": "private, no-store" } },
    );
  }
  if (error instanceof AccessDeniedError || error instanceof MemoryAccessDeniedError) {
    return Response.json(
      { code: errorCode(error), error: error.message },
      { status: 403, headers: { "cache-control": "private, no-store" } },
    );
  }
  if (error instanceof EvaluationSuiteNotFoundError) {
    return Response.json(
      { code: errorCode(error), error: error.message },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  }
  console.error("Unhandled Lore request error", error);
  return Response.json(
    { code: "internal_error", error: "Internal server error" },
    { status: 500, headers: { "cache-control": "private, no-store" } },
  );
}

function memoryEtag(version: number): string {
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

async function idempotencyRequest(
  request: Request,
  operation: string,
  payload: unknown,
): Promise<IdempotencyRequest | undefined> {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return undefined;
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw new BadRequestError("Idempotency-Key must contain 1 to 128 visible ASCII characters");
  }
  return {
    key,
    operation,
    requestHash: await mutationRequestHash({ operation, payload }),
  };
}

interface MemoryCursor {
  id: string;
  updatedAt: string;
}

function encodeCursor(cursor: MemoryCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(value: string | null): MemoryCursor | undefined {
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

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestError(`${name} is required`);
  }
  const normalized = value.trim();
  if (normalized.includes("\0")) {
    throw new BadRequestError(`${name} contains an invalid null character`);
  }
  if (normalized.length > maximumLength) {
    throw new BadRequestError(`${name} exceeds ${maximumLength} characters`);
  }
  return normalized;
}

function memoryScope(value: unknown): MemoryScope | undefined {
  if (value === undefined) return undefined;
  if (value === "shared" || value === "private") return value;
  throw new BadRequestError("scope must be shared or private");
}

function optionalTimestamp(value: string | null, name: string): string | undefined {
  if (value === null || value.trim() === "") return undefined;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new BadRequestError(`${name} must be an ISO 8601 timestamp`);
  }
  return timestamp.toISOString();
}

function metadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("metadata must be an object");
  }
  validateJsonStrings(value, "metadata");
  if (JSON.stringify(value).length > 100_000) {
    throw new BadRequestError("metadata exceeds 100000 characters");
  }
  return value as Record<string, unknown>;
}

function metadataFilter(value: string | null): Record<string, unknown> | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (value.length > 10_000) throw new BadRequestError("metadata exceeds 10000 characters");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BadRequestError("metadata must be valid JSON");
  }
  return metadata(parsed);
}

function validateJsonStrings(value: unknown, path: string): void {
  const pending: Array<{ depth: number; path: string; value: unknown }> = [
    { depth: 0, path, value },
  ];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    visited += 1;
    if (visited > 10_000) throw new BadRequestError(`${path} exceeds 10000 values`);
    if (current.depth > 32) throw new BadRequestError(`${path} exceeds 32 levels`);
    if (typeof current.value === "string") {
      if (current.value.includes("\0")) {
        throw new BadRequestError(`${current.path} contains an invalid null character`);
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      if (visited + pending.length + current.value.length > 10_000) {
        throw new BadRequestError(`${path} exceeds 10000 values`);
      }
      for (const [index, item] of current.value.entries()) {
        pending.push({ depth: current.depth + 1, path: `${current.path}[${index}]`, value: item });
      }
      continue;
    }
    if (current.value && typeof current.value === "object") {
      const entries = Object.entries(current.value);
      if (visited + pending.length + entries.length > 10_000) {
        throw new BadRequestError(`${path} exceeds 10000 values`);
      }
      for (const [key, item] of entries) {
        if (key.includes("\0")) {
          throw new BadRequestError(`${current.path} contains an invalid null character`);
        }
        pending.push({ depth: current.depth + 1, path: `${current.path}.${key}`, value: item });
      }
    }
  }
}

function queryInteger(
  url: URL,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new BadRequestError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function agentPermission(
  value: unknown,
  defaultPermission?: AgentGrantPermission,
): AgentGrantPermission {
  if (value === undefined && defaultPermission) return defaultPermission;
  if (value === "read" || value === "write") return value;
  throw new BadRequestError("permission must be read or write");
}

function agentStatus(value: unknown): AgentStatus {
  if (value === "active" || value === "disabled") return value;
  throw new BadRequestError("status must be active or disabled");
}

function uuidString(value: unknown, name: string): string {
  const result = requiredString(value, name, 36);
  const normalized = normalizeUuid(result);
  if (!normalized) throw new BadRequestError(`${name} must be a UUID`);
  return normalized;
}

function uuidArray(value: unknown, name: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new BadRequestError(`${name} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  return value.map((item, index) => uuidString(item, `${name}[${index}]`));
}

function evaluationCases(value: unknown): EvaluationCaseInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestError("cases must be a non-empty array");
  }
  if (value.length > 1_000) throw new BadRequestError("cases exceeds 1000 items");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BadRequestError(`cases[${index}] must be an object`);
    }
    const evaluationCase = item as Record<string, unknown>;
    const requestedLimit = evaluationCase.limit === undefined ? 10 : Number(evaluationCase.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
      throw new BadRequestError(`cases[${index}].limit must be an integer from 1 to 100`);
    }
    return {
      query: requiredString(evaluationCase.query, `cases[${index}].query`, 10_000),
      expectedMemoryIds: uuidArray(
        evaluationCase.expectedMemoryIds,
        `cases[${index}].expectedMemoryIds`,
        false,
      ),
      forbiddenMemoryIds:
        evaluationCase.forbiddenMemoryIds === undefined
          ? []
          : uuidArray(
              evaluationCase.forbiddenMemoryIds,
              `cases[${index}].forbiddenMemoryIds`,
              true,
            ),
      limit: requestedLimit,
    };
  });
}

function requireHumanActor(actor: ActorContext): ActorContext {
  if (actor.agentId) throw new AccessDeniedError("This operation requires a User");
  return actor;
}

export function createActorHandlers(database: PostgresDatabase) {
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const actor = requireHumanActor(await resolver.resolveActor(request));
        return Response.json(
          { kind: "human", userId: actor.userId },
          { headers: { "cache-control": "private, no-store" } },
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createCapabilitiesHandlers(
  database: PostgresDatabase,
  options: { embeddingConfigured: boolean },
) {
  const operations = createOperationsModule(database, options);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        await resolver.resolveActor(request);
        return Response.json(await operations.capabilities(), {
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createWorkspaceHandlers(database: PostgresDatabase) {
  const access = createAccessModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const user = await resolver.resolveUser(request);
        return Response.json(await access.listWorkspaces(user));
      } catch (error) {
        return errorResponse(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      try {
        const user = await resolver.resolveUser(request);
        const body = await jsonObject(request);
        const workspace = await access.createWorkspace(user, {
          name: requiredString(body.name, "name", 120),
        });
        return Response.json(workspace, { status: 201 });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createAgentHandlers(database: PostgresDatabase) {
  const access = createAccessModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const actor = requireHumanActor(await resolver.resolveActor(request));
        return Response.json(await access.listAgents(actor), {
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      try {
        const actor = requireHumanActor(await resolver.resolveActor(request));
        const body = await jsonObject(request);
        const agent = await access.createAgentForWorkspace(actor, {
          name: requiredString(body.name, "name", 120),
          permission: agentPermission(body.permission, "read"),
        });
        return Response.json(agent, {
          status: 201,
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createAgentByIdHandlers(database: PostgresDatabase) {
  const access = createAccessModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async PATCH(request: Request, agentId: string): Promise<Response> {
      try {
        const normalizedAgentId = uuidString(agentId, "agentId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        const body = await jsonObject(request);
        const unsupportedField = Object.keys(body).find(
          (field) => field !== "name" && field !== "status",
        );
        if (unsupportedField) {
          throw new BadRequestError(`${unsupportedField} is not a supported Agent field`);
        }
        if (body.name === undefined && body.status === undefined) {
          throw new BadRequestError("name or status is required");
        }
        const agent = await access.updateAgent(actor, normalizedAgentId, {
          name: body.name === undefined ? undefined : requiredString(body.name, "name", 120),
          status: body.status === undefined ? undefined : agentStatus(body.status),
        });
        return agent
          ? Response.json(agent, {
              headers: { "cache-control": "private, no-store" },
            })
          : Response.json(
              { code: "not_found", error: "Agent not found" },
              {
                status: 404,
                headers: { "cache-control": "private, no-store" },
              },
            );
      } catch (error) {
        return errorResponse(error);
      }
    },

    async DELETE(request: Request, agentId: string): Promise<Response> {
      try {
        const normalizedAgentId = uuidString(agentId, "agentId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        const result = await access.deleteAgent(actor, normalizedAgentId);
        if (result === "deleted") {
          return new Response(null, {
            status: 204,
            headers: { "cache-control": "private, no-store" },
          });
        }
        if (result === "must_disable") {
          return Response.json(
            { code: "invalid_request", error: "Disable Agent before deleting it" },
            {
              status: 409,
              headers: { "cache-control": "private, no-store" },
            },
          );
        }
        return Response.json(
          { code: "not_found", error: "Agent not found" },
          {
            status: 404,
            headers: { "cache-control": "private, no-store" },
          },
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createAgentCredentialHandlers(database: PostgresDatabase) {
  const access = createAccessModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request, agentId: string): Promise<Response> {
      try {
        const normalizedAgentId = uuidString(agentId, "agentId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        return Response.json(await access.listAgentCredentials(actor, normalizedAgentId), {
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async POST(request: Request, agentId: string): Promise<Response> {
      try {
        const normalizedAgentId = uuidString(agentId, "agentId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        return Response.json(await access.issueAgentCredential(actor, normalizedAgentId), {
          status: 201,
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createAgentCredentialByIdHandlers(database: PostgresDatabase) {
  const access = createAccessModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async DELETE(request: Request, credentialId: string): Promise<Response> {
      try {
        const normalizedCredentialId = uuidString(credentialId, "credentialId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        const revoked = await access.revokeAgentCredential(actor, normalizedCredentialId);
        return revoked
          ? new Response(null, { status: 204 })
          : Response.json(
              { code: "not_found", error: "Agent credential not found" },
              { status: 404 },
            );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createAgentGrantHandlers(database: PostgresDatabase) {
  const access = createAccessModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async PUT(request: Request, agentId: string): Promise<Response> {
      try {
        const normalizedAgentId = uuidString(agentId, "agentId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        const body = await jsonObject(request);
        return Response.json(
          await access.grantAgent(actor, normalizedAgentId, {
            permission: agentPermission(body.permission),
          }),
          { headers: { "cache-control": "private, no-store" } },
        );
      } catch (error) {
        return errorResponse(error);
      }
    },

    async DELETE(request: Request, agentId: string): Promise<Response> {
      try {
        const normalizedAgentId = uuidString(agentId, "agentId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        const revoked = await access.revokeAgentGrant(actor, normalizedAgentId);
        return revoked
          ? new Response(null, { status: 204 })
          : Response.json(
              { code: "not_found", error: "Active Agent grant not found" },
              { status: 404 },
            );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createEvaluationSuiteHandlers(
  database: PostgresDatabase,
  options: EvaluationModuleOptions = {},
) {
  const evaluations = createEvaluationModule(database, options);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const actor = requireHumanActor(await resolver.resolveActor(request));
        return Response.json(await evaluations.listSuites(actor));
      } catch (error) {
        return errorResponse(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      try {
        const actor = requireHumanActor(await resolver.resolveActor(request));
        const body = await jsonObject(request);
        const requestedVersion = body.version === undefined ? 1 : Number(body.version);
        if (!Number.isInteger(requestedVersion) || requestedVersion < 1) {
          throw new BadRequestError("version must be a positive integer");
        }
        const suite = await evaluations.createSuite(actor, {
          name: requiredString(body.name, "name", 120),
          version: requestedVersion,
          description:
            body.description === undefined
              ? undefined
              : requiredString(body.description, "description", 10_000),
          cases: evaluationCases(body.cases),
        });
        return Response.json(suite, { status: 201 });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createEvaluationRunHandlers(
  database: PostgresDatabase,
  options: EvaluationModuleOptions = {},
) {
  const evaluations = createEvaluationModule(database, options);
  const resolver = createRequestContextResolver(database);
  return {
    async POST(request: Request, suiteId: string): Promise<Response> {
      try {
        const normalizedSuiteId = uuidString(suiteId, "suiteId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        return Response.json(await evaluations.runSuite(actor, normalizedSuiteId), { status: 201 });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createEvaluationRunByIdHandlers(
  database: PostgresDatabase,
  options: EvaluationModuleOptions = {},
) {
  const evaluations = createEvaluationModule(database, options);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request, runId: string): Promise<Response> {
      try {
        const normalizedRunId = uuidString(runId, "runId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        const run = await evaluations.getRun(actor, normalizedRunId);
        return run
          ? Response.json(run)
          : Response.json(
              { code: "not_found", error: "Evaluation run not found" },
              { status: 404 },
            );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
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
        const input = {
          content: requiredString(body.content, "content", 1_000_000),
          scope: memoryScope(body.scope),
          metadata: metadata(body.metadata),
        };
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

export function createGraphHandlers(database: PostgresDatabase) {
  const graph = createMemoryGraphModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const url = new URL(request.url);
        const requestedLimit = Number(url.searchParams.get("limit") ?? "5000");
        const limit = Number.isFinite(requestedLimit) ? requestedLimit : 5000;
        return Response.json(
          await observeOperation("graph.read", () => graph.read(actor, { limit })),
          {
            headers: { "cache-control": "private, no-store" },
          },
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createPortabilityHandlers(database: PostgresDatabase) {
  const portability = createPortabilityModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async EXPORT(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const archive = await observeOperation("portability.export", () =>
          portability.exportWorkspace(actor),
        );
        return Response.json(archive, {
          headers: {
            "cache-control": "private, no-store",
            "content-disposition": `attachment; filename="lore-workspace-${actor.workspaceId}.json"`,
          },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async IMPORT(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const body = await jsonObject(request);
        if (JSON.stringify(body).length > 50_000_000) {
          throw new BadRequestError("Workspace archive exceeds 50000000 characters");
        }
        const archive = body.archive;
        const ownerMap = body.ownerMap;
        if (!archive || typeof archive !== "object" || Array.isArray(archive)) {
          throw new BadRequestError("archive must be an object");
        }
        if (!ownerMap || typeof ownerMap !== "object" || Array.isArray(ownerMap)) {
          throw new BadRequestError("ownerMap must be an object");
        }
        const result = await observeOperation("portability.import", () =>
          portability.importWorkspace(actor, {
            archive,
            ownerMap,
            conflictPolicy: body.conflictPolicy,
            dryRun: body.dryRun === true,
          } as ImportWorkspaceArchive),
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
        if (body.content === undefined && body.scope === undefined && body.metadata === undefined) {
          throw new BadRequestError("At least one Memory field is required");
        }
        const expectedVersion = expectedMemoryVersion(request);
        const input = {
          content:
            body.content === undefined
              ? undefined
              : requiredString(body.content, "content", 1_000_000),
          scope: memoryScope(body.scope),
          metadata: metadata(body.metadata),
        };
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
