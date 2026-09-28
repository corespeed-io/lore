import type { PostgresDatabase } from "@corespeed/lore-core";
import { createAgentsModule } from "@/modules/agents/service";
import { createWorkspacesModule } from "@/modules/workspaces/service";
import { createAgentAuthenticator } from "@/server/auth/agent-credentials";

/**
 * Test setup that needs Workspaces, Memberships, Agents, grants, and credentials
 * together. Product code uses the Workspaces and Agents services and the Agent
 * authenticator separately.
 */
export function createAccessModule(database: PostgresDatabase) {
  const authenticator = createAgentAuthenticator(database);
  return {
    ...createWorkspacesModule(database),
    ...createAgentsModule(database),
    authenticateAgent: authenticator.authenticate,
  };
}
