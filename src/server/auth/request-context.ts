import type { PostgresDatabase } from "@corespeed/lore-core";
import type { ActorContext, UserContext } from "@/server/auth/actor-context";
import { DomainError } from "@/server/errors";
import { PendingActor, PendingUser } from "./actor-admission";
import { agentCredentialHash } from "./agent-credentials";
import {
  type AuthPrincipal,
  checkAuth,
  RequestAuthenticationError,
  WorkspaceAccessError,
} from "./auth";

// Admission refuses with the same two failures, so they live beside it.
export { RequestAuthenticationError, WorkspaceAccessError };

export class RequestInputError extends DomainError {
  override name = "RequestInputError";
  readonly code = "invalid_request";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeUuid(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
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
  // Hono passes the principal its admission already verified; other callers verify here.
  async function verifiedPrincipal(
    request: Request,
    admitted: AuthPrincipal | undefined,
  ): Promise<AuthPrincipal> {
    if (admitted) return admitted;
    const authentication = await checkAuth(request.headers);
    if (!authentication.ok || !authentication.principal) {
      throw new RequestAuthenticationError(authentication.detail ?? "Authentication required");
    }
    return authentication.principal;
  }

  return {
    /**
     * The verified human, not yet registered: the request's first transaction
     * registers the Identity as its prefix (`userTransaction`).
     */
    async requestUser(request: Request, principal?: AuthPrincipal): Promise<PendingUser> {
      if (bearerToken(request)) {
        throw new RequestAuthenticationError("Agent credential cannot act as a human User");
      }
      return new PendingUser(await verifiedPrincipal(request, principal));
    },

    /** The registered User, in a transaction of its own (one round trip). */
    async resolveUser(request: Request, principal?: AuthPrincipal): Promise<UserContext> {
      return (await this.requestUser(request, principal)).resolve(database);
    },

    /**
     * The Actor the request names, not yet admitted: its first transaction admits
     * it as a prefix (`actorTransaction`). Input errors are still thrown here.
     */
    async requestActor(request: Request, principal?: AuthPrincipal): Promise<PendingActor> {
      const workspaceId = requestedWorkspace(request);
      const token = bearerToken(request);
      if (token) return PendingActor.agent(await agentCredentialHash(token), workspaceId);
      return PendingActor.human(await verifiedPrincipal(request, principal), workspaceId);
    },

    /** The admitted Actor, in a transaction of its own (one round trip). */
    async resolveActor(request: Request, principal?: AuthPrincipal): Promise<ActorContext> {
      return (await this.requestActor(request, principal)).resolve(database);
    },
  };
}
