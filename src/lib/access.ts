import type { PostgresDatabase } from "@corespeed/lore-core";
import {
  type ActorContext,
  installActorContext,
  installUserContext,
  isPostgresAccessDenied,
  type UserContext,
} from "@corespeed/lore-core";

export type AgentStatus = "active" | "disabled";
export type AgentGrantPermission = "read" | "write";
export type AgentGrantStatus = "active" | "revoked";
export type AgentDeletionResult = "deleted" | "must_disable" | "not_found";
export type MembershipRole = "owner" | "admin" | "member";
export type MembershipStatus = "active" | "suspended";

export class AccessDeniedError extends Error {
  override name = "AccessDeniedError";
}

export interface Agent {
  id: string;
  ownerUserId: string;
  name: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentWorkspaceGrant {
  workspaceId: string;
  agentId: string;
  permission: AgentGrantPermission;
  status: AgentGrantStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAgent extends Agent {
  permission: AgentGrantPermission;
  grantStatus: AgentGrantStatus;
}

export interface IssuedAgentCredential {
  id: string;
  prefix: string;
  token: string;
}

export interface AgentCredential {
  id: string;
  agentId: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSummary extends Workspace {
  role: MembershipRole;
}

interface AgentRow {
  id: string;
  owner_user_id: string;
  name: string;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
}

interface AgentGrantRow {
  workspace_id: string;
  agent_id: string;
  permission: AgentGrantPermission;
  status: AgentGrantStatus;
  created_at: string;
  updated_at: string;
}

interface WorkspaceAgentRow extends AgentRow {
  permission: AgentGrantPermission;
  grant_status: AgentGrantStatus;
}

interface AuthenticatedAgentRow {
  user_id: string;
  agent_id: string;
}

interface AgentCredentialRow {
  id: string;
  agent_id: string;
  secret_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface WorkspaceRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface MembershipRow {
  workspace_id: string;
  user_id: string;
  role: MembershipRole;
  status: MembershipStatus;
  created_at: string;
  updated_at: string;
}

interface WorkspaceSummaryRow extends WorkspaceRow {
  role: MembershipRole;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function translateAccessError<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (isPostgresAccessDenied(error)) throw new AccessDeniedError("Actor is not authorized");
    throw error;
  }
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toGrant(row: AgentGrantRow): AgentWorkspaceGrant {
  return {
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    permission: row.permission,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWorkspaceAgent(row: WorkspaceAgentRow): WorkspaceAgent {
  return {
    ...toAgent(row),
    permission: row.permission,
    grantStatus: row.grant_status,
  };
}

function toAgentCredential(row: AgentCredentialRow): AgentCredential {
  return {
    id: row.id,
    agentId: row.agent_id,
    prefix: row.secret_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMembership(row: MembershipRow): WorkspaceMembership {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWorkspaceSummary(row: WorkspaceSummaryRow): WorkspaceSummary {
  return { ...toWorkspace(row), role: row.role };
}

export function createAccessModule(database: PostgresDatabase) {
  async function listWorkspaces(user: UserContext): Promise<WorkspaceSummary[]> {
    return database.transaction(async (transaction) => {
      await installUserContext(transaction, user);
      const result = await transaction.query<WorkspaceSummaryRow>(
        "SELECT * FROM lore.list_workspaces()",
      );
      return result.rows.map(toWorkspaceSummary);
    });
  }

  return {
    async createWorkspace(user: UserContext, input: { name: string }): Promise<Workspace> {
      return translateAccessError(() =>
        database.transaction(async (transaction) => {
          await installUserContext(transaction, user);
          const result = await transaction.query<WorkspaceRow>(
            "SELECT * FROM lore.create_workspace($1, $2)",
            [crypto.randomUUID(), input.name],
          );
          return toWorkspace(result.rows[0]);
        }),
      );
    },

    listWorkspaces,

    async selectWorkspace(user: UserContext, workspaceId: string): Promise<ActorContext | null> {
      const normalizedWorkspaceId = workspaceId.toLowerCase();
      const workspaces = await listWorkspaces(user);
      return workspaces.some((workspace) => workspace.id === normalizedWorkspaceId)
        ? { userId: user.userId, workspaceId: normalizedWorkspaceId }
        : null;
    },

    async addMember(
      actor: ActorContext,
      userId: string,
      input: { role: MembershipRole },
    ): Promise<WorkspaceMembership> {
      return translateAccessError(() =>
        database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const result = await transaction.query<MembershipRow>(
            `INSERT INTO memberships (workspace_id, user_id, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (workspace_id, user_id) DO UPDATE
             SET role = EXCLUDED.role, status = 'active', updated_at = now()
             RETURNING *`,
            [actor.workspaceId, userId, input.role],
          );
          return toMembership(result.rows[0]);
        }),
      );
    },

    async createAgent(actor: ActorContext, input: { name: string }): Promise<Agent> {
      return translateAccessError(() =>
        database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const result = await transaction.query<AgentRow>(
            `INSERT INTO agents (id, owner_user_id, name)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [crypto.randomUUID(), actor.userId, input.name],
          );
          return toAgent(result.rows[0]);
        }),
      );
    },

    async createAgentForWorkspace(
      actor: ActorContext,
      input: { name: string; permission: AgentGrantPermission },
    ): Promise<WorkspaceAgent> {
      return translateAccessError(() =>
        database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const agentId = crypto.randomUUID();
          const agentResult = await transaction.query<AgentRow>(
            `INSERT INTO agents (id, owner_user_id, name)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [agentId, actor.userId, input.name],
          );
          const grantResult = await transaction.query<AgentGrantRow>(
            `INSERT INTO agent_workspace_grants (workspace_id, agent_id, permission)
             VALUES ($1, $2, $3)
             ON CONFLICT (workspace_id, agent_id) DO UPDATE
             SET permission = EXCLUDED.permission, status = 'active', updated_at = now()
             RETURNING *`,
            [actor.workspaceId, agentId, input.permission],
          );
          return {
            ...toAgent(agentResult.rows[0]),
            permission: grantResult.rows[0].permission,
            grantStatus: grantResult.rows[0].status,
          };
        }),
      );
    },

    async listAgents(actor: ActorContext): Promise<WorkspaceAgent[]> {
      return translateAccessError(() =>
        database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const result = await transaction.query<WorkspaceAgentRow>(
            `SELECT
               agent.*,
               workspace_grant.permission,
               workspace_grant.status AS grant_status
             FROM agents agent
             JOIN agent_workspace_grants workspace_grant
               ON workspace_grant.agent_id = agent.id
              AND workspace_grant.workspace_id = $1
             WHERE agent.owner_user_id = $2
             ORDER BY agent.created_at DESC, agent.id`,
            [actor.workspaceId, actor.userId],
          );
          return result.rows.map(toWorkspaceAgent);
        }),
      );
    },

    async updateAgent(
      actor: ActorContext,
      agentId: string,
      input: { name?: string; status?: AgentStatus },
    ): Promise<WorkspaceAgent | null> {
      return translateAccessError(() =>
        database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const result = await transaction.query<WorkspaceAgentRow>(
            `UPDATE agents agent
             SET
               name = COALESCE($4, agent.name),
               status = COALESCE($5::agent_status, agent.status),
               updated_at = now()
             FROM agent_workspace_grants workspace_grant
             WHERE agent.id = $1
               AND agent.owner_user_id = $2
               AND workspace_grant.workspace_id = $3
               AND workspace_grant.agent_id = agent.id
             RETURNING
               agent.*,
               workspace_grant.permission,
               workspace_grant.status AS grant_status`,
            [agentId, actor.userId, actor.workspaceId, input.name ?? null, input.status ?? null],
          );
          return result.rows[0] ? toWorkspaceAgent(result.rows[0]) : null;
        }),
      );
    },

    async deleteAgent(actor: ActorContext, agentId: string): Promise<AgentDeletionResult> {
      return translateAccessError(() =>
        database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const target = await transaction.query<{ status: AgentStatus }>(
            `SELECT agent.status
             FROM agents agent
             WHERE agent.id = $1
               AND agent.owner_user_id = $2
               AND EXISTS (
                 SELECT 1
                 FROM agent_workspace_grants workspace_grant
                 WHERE workspace_grant.workspace_id = $3
                   AND workspace_grant.agent_id = agent.id
               )
             FOR UPDATE`,
            [agentId, actor.userId, actor.workspaceId],
          );
          if (!target.rows[0]) return "not_found";
          if (target.rows[0].status !== "disabled") return "must_disable";
          const deleted = await transaction.query<{ id: string }>(
            `DELETE FROM agents agent
             WHERE agent.id = $1
               AND agent.owner_user_id = $2
               AND agent.status = 'disabled'
               AND EXISTS (
                 SELECT 1
                 FROM agent_workspace_grants workspace_grant
                 WHERE workspace_grant.workspace_id = $3
                   AND workspace_grant.agent_id = agent.id
               )
             RETURNING agent.id`,
            [agentId, actor.userId, actor.workspaceId],
          );
          return deleted.rows[0] ? "deleted" : "not_found";
        }),
      );
    },

    async grantAgent(
      actor: ActorContext,
      agentId: string,
      input: { permission: AgentGrantPermission },
    ): Promise<AgentWorkspaceGrant> {
      return translateAccessError(() =>
        database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const result = await transaction.query<AgentGrantRow>(
            `INSERT INTO agent_workspace_grants (workspace_id, agent_id, permission)
             VALUES ($1, $2, $3)
             ON CONFLICT (workspace_id, agent_id) DO UPDATE
             SET permission = EXCLUDED.permission, status = 'active', updated_at = now()
             RETURNING *`,
            [actor.workspaceId, agentId, input.permission],
          );
          return toGrant(result.rows[0]);
        }),
      );
    },

    async issueAgentCredential(
      actor: ActorContext,
      agentId: string,
    ): Promise<IssuedAgentCredential> {
      const secret = randomSecret();
      const token = `lore_agent_${secret}`;
      const prefix = secret.slice(0, 12);
      const secretHash = await sha256Hex(token);

      return translateAccessError(() =>
        database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const id = crypto.randomUUID();
          const result = await transaction.query<{ id: string; secret_prefix: string }>(
            `INSERT INTO agent_credentials (id, agent_id, secret_prefix, secret_hash)
             SELECT $1, agent.id, $3, $4
             FROM agent_workspace_grants workspace_grant
             JOIN agents agent ON agent.id = workspace_grant.agent_id
             WHERE workspace_grant.workspace_id = $2
               AND workspace_grant.agent_id = $5
               AND workspace_grant.status = 'active'
               AND agent.status = 'active'
             RETURNING id, secret_prefix`,
            [id, actor.workspaceId, prefix, secretHash, agentId],
          );
          if (!result.rows[0]) {
            throw new AccessDeniedError("Agent is not active in the selected Workspace");
          }
          return { id: result.rows[0].id, prefix: result.rows[0].secret_prefix, token };
        }),
      );
    },

    async listAgentCredentials(actor: ActorContext, agentId: string): Promise<AgentCredential[]> {
      return translateAccessError(() =>
        database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const result = await transaction.query<AgentCredentialRow>(
            `SELECT
               credential.id,
               credential.agent_id,
               credential.secret_prefix,
               credential.created_at,
               credential.last_used_at,
               credential.revoked_at
             FROM agent_credentials credential
             WHERE credential.agent_id = $1
               AND EXISTS (
                 SELECT 1
                 FROM agent_workspace_grants workspace_grant
                 WHERE workspace_grant.workspace_id = $2
                   AND workspace_grant.agent_id = credential.agent_id
               )
             ORDER BY credential.created_at DESC, credential.id`,
            [agentId, actor.workspaceId],
          );
          return result.rows.map(toAgentCredential);
        }),
      );
    },

    async authenticateAgent(token: string, workspaceId: string): Promise<ActorContext | null> {
      const secretHash = await sha256Hex(token);
      return database.transaction(async (transaction) => {
        const result = await transaction.query<AuthenticatedAgentRow>(
          "SELECT * FROM lore.authenticate_agent_credential($1, $2)",
          [secretHash, workspaceId],
        );
        const authenticated = result.rows[0];
        return authenticated
          ? {
              workspaceId,
              userId: authenticated.user_id,
              agentId: authenticated.agent_id,
            }
          : null;
      });
    },

    async revokeAgentCredential(actor: ActorContext, credentialId: string): Promise<boolean> {
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<{ id: string }>(
          `UPDATE agent_credentials credential
           SET revoked_at = now()
           WHERE credential.id = $1
             AND credential.revoked_at IS NULL
             AND EXISTS (
               SELECT 1
               FROM agent_workspace_grants workspace_grant
               WHERE workspace_grant.workspace_id = $2
                 AND workspace_grant.agent_id = credential.agent_id
             )
           RETURNING credential.id`,
          [credentialId, actor.workspaceId],
        );
        return result.rows.length === 1;
      });
    },

    async revokeAgentGrant(actor: ActorContext, agentId: string): Promise<boolean> {
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const result = await transaction.query<{ agent_id: string }>(
          `UPDATE agent_workspace_grants
           SET status = 'revoked', updated_at = now()
           WHERE workspace_id = $1 AND agent_id = $2 AND status = 'active'
           RETURNING agent_id`,
          [actor.workspaceId, agentId],
        );
        return result.rows.length === 1;
      });
    },
  };
}
