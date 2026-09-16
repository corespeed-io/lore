import type { PostgresDatabase } from "@corespeed/lore-core";
import type { AgentGrantPermission, AgentStatus } from "@/server/auth/access";
import { createAccessModule } from "@/server/auth/access";
import { createRequestContextResolver } from "@/server/auth/request-context";
import { errorResponse } from "@/server/http/errors";
import {
  BadRequestError,
  jsonObject,
  requiredString,
  requireHumanActor,
  uuidString,
} from "@/server/http/input";

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
