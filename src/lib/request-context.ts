import { createAccessModule } from "./access";
import type { ActorContext, UserContext } from "./actor-context";
import { checkAuth } from "./auth";
import type { PostgresDatabase } from "./db";
import { createIdentityModule } from "./identity";

export class RequestAuthenticationError extends Error {
  override name = "RequestAuthenticationError";
  readonly status = 401;
}

export class WorkspaceAccessError extends Error {
  override name = "WorkspaceAccessError";
  readonly status = 403;
}

export class RequestInputError extends Error {
  override name = "RequestInputError";
  readonly status = 400;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeUuid(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function requestCookies(request: Request) {
  const values = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) values.set(name, decodeURIComponent(value));
  }
  return {
    get(name: string) {
      const value = values.get(name);
      return value === undefined ? undefined : { value };
    },
  };
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer lore_agent_") ? authorization.slice(7) : null;
}

function requestedWorkspace(request: Request): string {
  const requested = request.headers.get("x-lore-workspace-id")?.trim();
  if (!requested) throw new WorkspaceAccessError("x-lore-workspace-id is required");
  const workspaceId = normalizeUuid(requested);
  if (!workspaceId) throw new RequestInputError("x-lore-workspace-id must be a UUID");
  return workspaceId;
}

export function createRequestContextResolver(database: PostgresDatabase) {
  const access = createAccessModule(database);
  const identities = createIdentityModule(database);

  return {
    async resolveUser(request: Request): Promise<UserContext> {
      if (bearerToken(request)) {
        throw new RequestAuthenticationError("Agent credential cannot act as a human User");
      }
      const authentication = await checkAuth(request.headers, requestCookies(request));
      if (!authentication.ok || !authentication.principal) {
        throw new RequestAuthenticationError(authentication.detail ?? "Authentication required");
      }
      const user = await identities.register(authentication.principal);
      return { userId: user.id };
    },

    async resolveActor(request: Request): Promise<ActorContext> {
      const workspaceId = requestedWorkspace(request);
      const token = bearerToken(request);
      if (token) {
        const actor = await access.authenticateAgent(token, workspaceId);
        if (!actor) throw new WorkspaceAccessError("Agent is not granted to this Workspace");
        return actor;
      }

      const user = await this.resolveUser(request);
      const actor = await access.selectWorkspace(user, workspaceId);
      if (!actor) throw new WorkspaceAccessError("User is not an active Workspace member");
      return actor;
    },
  };
}
