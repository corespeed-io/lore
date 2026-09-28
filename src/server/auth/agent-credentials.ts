import type { PostgresDatabase } from "@corespeed/lore-core";
import type { ActorContext } from "@/server/auth/actor-context";

/**
 * Agent bearer credentials: the token format, its stored hash, and verification.
 * Issuing a credential is Agent administration (`src/modules/agents`); proving one
 * is authentication, so both share the hash defined here.
 */
const AGENT_TOKEN_PREFIX = "lore_agent_";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A new bearer token, the prefix shown to its owner, and the hash Lore stores. */
export async function newAgentCredentialSecret(): Promise<{
  token: string;
  prefix: string;
  secretHash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const token = `${AGENT_TOKEN_PREFIX}${secret}`;
  return { token, prefix: secret.slice(0, 12), secretHash: await sha256Hex(token) };
}

interface AuthenticatedAgentRow {
  user_id: string;
  agent_id: string;
}

export function createAgentAuthenticator(database: PostgresDatabase) {
  return {
    /** The Agent Actor a bearer token proves in this Workspace, or null. */
    async authenticate(token: string, workspaceId: string): Promise<ActorContext | null> {
      const secretHash = await sha256Hex(token);
      return database.transaction(async (transaction) => {
        const result = await transaction.query<AuthenticatedAgentRow>(
          "SELECT * FROM lore.authenticate_agent_credential($1, $2)",
          [secretHash, workspaceId],
        );
        const authenticated = result.rows[0];
        return authenticated
          ? { workspaceId, userId: authenticated.user_id, agentId: authenticated.agent_id }
          : null;
      });
    },
  };
}
