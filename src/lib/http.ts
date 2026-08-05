import { AccessDeniedError, type AgentGrantPermission, createAccessModule } from "./access";
import type { ActorContext } from "./actor-context";
import type { PostgresDatabase } from "./db";
import {
  createEvaluationModule,
  type EvaluationCaseInput,
  EvaluationSuiteNotFoundError,
} from "./evaluation";
import { createMemoryGraphModule } from "./graph";
import { createMemoryModule, MemoryAccessDeniedError, type MemoryScope } from "./memory";
import {
  createRequestContextResolver,
  normalizeUuid,
  RequestAuthenticationError,
  RequestInputError,
  WorkspaceAccessError,
} from "./request-context";

class BadRequestError extends Error {
  readonly status = 400;
}

function errorResponse(error: unknown): Response {
  if (
    error instanceof BadRequestError ||
    error instanceof RequestInputError ||
    error instanceof RequestAuthenticationError ||
    error instanceof WorkspaceAccessError
  ) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof AccessDeniedError || error instanceof MemoryAccessDeniedError) {
    return Response.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof EvaluationSuiteNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  console.error("Unhandled Lore request error", error);
  return Response.json({ error: "Internal server error" }, { status: 500 });
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

function metadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("metadata must be an object");
  }
  validateJsonStrings(value, "metadata");
  return value as Record<string, unknown>;
}

function validateJsonStrings(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (value.includes("\0")) {
      throw new BadRequestError(`${path} contains an invalid null character`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateJsonStrings(item, `${path}[${index}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key.includes("\0")) {
        throw new BadRequestError(`${path} contains an invalid null character`);
      }
      validateJsonStrings(item, `${path}.${key}`);
    }
  }
}

function agentPermission(value: unknown): AgentGrantPermission {
  if (value === "read" || value === "write") return value;
  throw new BadRequestError("permission must be read or write");
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
  if (actor.agentId) throw new AccessDeniedError("Agent administration requires a User");
  return actor;
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
        return Response.json(await access.listAgents(actor));
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
          permission: agentPermission(body.permission),
        });
        return Response.json(agent, { status: 201 });
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
    async POST(request: Request, agentId: string): Promise<Response> {
      try {
        const normalizedAgentId = uuidString(agentId, "agentId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        return Response.json(await access.issueAgentCredential(actor, normalizedAgentId), {
          status: 201,
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
          : Response.json({ error: "Agent credential not found" }, { status: 404 });
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
    async DELETE(request: Request, agentId: string): Promise<Response> {
      try {
        const normalizedAgentId = uuidString(agentId, "agentId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        const revoked = await access.revokeAgentGrant(actor, normalizedAgentId);
        return revoked
          ? new Response(null, { status: 204 })
          : Response.json({ error: "Active Agent grant not found" }, { status: 404 });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createEvaluationSuiteHandlers(database: PostgresDatabase) {
  const evaluations = createEvaluationModule(database);
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

export function createEvaluationRunHandlers(database: PostgresDatabase) {
  const evaluations = createEvaluationModule(database);
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

export function createEvaluationRunByIdHandlers(database: PostgresDatabase) {
  const evaluations = createEvaluationModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request, runId: string): Promise<Response> {
      try {
        const normalizedRunId = uuidString(runId, "runId");
        const actor = requireHumanActor(await resolver.resolveActor(request));
        const run = await evaluations.getRun(actor, normalizedRunId);
        return run
          ? Response.json(run)
          : Response.json({ error: "Evaluation run not found" }, { status: 404 });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createMemoryHandlers(database: PostgresDatabase) {
  const memories = createMemoryModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const url = new URL(request.url);
        const requestedQuery = url.searchParams.get("q");
        const query = requestedQuery?.trim() ? requiredString(requestedQuery, "q", 10_000) : "";
        const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
        const limit = Number.isFinite(requestedLimit) ? requestedLimit : 50;
        return Response.json(
          query
            ? await memories.search(actor, { query, limit })
            : await memories.list(actor, { limit }),
        );
      } catch (error) {
        return errorResponse(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      try {
        const actor = await resolver.resolveActor(request);
        const body = await jsonObject(request);
        const memory = await memories.remember(actor, {
          content: requiredString(body.content, "content", 1_000_000),
          scope: memoryScope(body.scope),
          metadata: metadata(body.metadata),
        });
        return Response.json(memory, { status: 201 });
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
        const requestedLimit = Number(url.searchParams.get("limit") ?? "100");
        const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
        return Response.json(await graph.read(actor, { limit }), {
          headers: { "cache-control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createMemoryByIdHandlers(database: PostgresDatabase) {
  const memories = createMemoryModule(database);
  const resolver = createRequestContextResolver(database);
  return {
    async GET(request: Request, id: string): Promise<Response> {
      try {
        const memoryId = uuidString(id, "memoryId");
        const actor = await resolver.resolveActor(request);
        const memory = await memories.retrieve(actor, memoryId);
        return memory
          ? Response.json(memory)
          : Response.json({ error: "Memory not found" }, { status: 404 });
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
        const memory = await memories.update(actor, memoryId, {
          content:
            body.content === undefined
              ? undefined
              : requiredString(body.content, "content", 1_000_000),
          scope: memoryScope(body.scope),
          metadata: metadata(body.metadata),
        });
        return memory
          ? Response.json(memory)
          : Response.json({ error: "Memory not found" }, { status: 404 });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async DELETE(request: Request, id: string): Promise<Response> {
      try {
        const memoryId = uuidString(id, "memoryId");
        const actor = await resolver.resolveActor(request);
        const forgotten = await memories.forget(actor, memoryId);
        return forgotten
          ? new Response(null, { status: 204 })
          : Response.json({ error: "Memory not found" }, { status: 404 });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
