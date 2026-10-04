import type { PostgresDatabase } from "@corespeed/lore-core";
import type { ActorContext } from "@/server/auth/actor-context";
import { installActorContext } from "@/server/auth/actor-context";
import { newAgentCredentialSecret } from "@/server/auth/agent-credentials";
import { refusingDeniedAccess } from "@/server/database/access-denied";
import { AccessDeniedError, DomainError } from "@/server/errors";

export type AgentStatus = "active" | "disabled";
export type AgentGrantPermission = "read" | "write";
export type AgentGrantStatus = "active" | "revoked";

/** An Agent is deleted only once it is disabled. */
export class AgentNotDisabledError extends DomainError {
  override name = "AgentNotDisabledError";
  readonly code = "agent_not_disabled";
  constructor() {
    super("Disable Agent before deleting it");
  }
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

interface AgentCredentialRow {
  id: string;
  agent_id: string;
  secret_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
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

/**
 * A User's own Agents, their Workspace grants, and their bearer credentials.
 * Agent records are user-private: every read and write is scoped to the caller.
 */
export function createAgentsModule(database: PostgresDatabase) {
  return {
    async createAgent(actor: ActorContext, input: { name: string }): Promise<Agent> {
      return refusingDeniedAccess(() =>
        database.transaction(async (transaction) => {
          installActorContext(transaction, actor);
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
      return refusingDeniedAccess(() =>
        database.transaction(async (transaction) => {
          installActorContext(transaction, actor);
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
      return refusingDeniedAccess(() =>
        database.transaction(async (transaction) => {
          installActorContext(transaction, actor);
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
      return refusingDeniedAccess(() =>
        database.transaction(async (transaction) => {
          installActorContext(transaction, actor);
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

    /**
     * Delete a disabled Agent with its grants and credentials; its Memories stay and
     * lose their creating-Agent reference. False when this caller has no such Agent.
     */
    async deleteAgent(actor: ActorContext, agentId: string): Promise<boolean> {
      return refusingDeniedAccess(() =>
        database.transaction(async (transaction) => {
          installActorContext(transaction, actor);
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
          if (!target.rows[0]) return false;
          if (target.rows[0].status !== "disabled") throw new AgentNotDisabledError();
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
          return deleted.rows.length === 1;
        }),
      );
    },

    async grantAgent(
      actor: ActorContext,
      agentId: string,
      input: { permission: AgentGrantPermission },
    ): Promise<AgentWorkspaceGrant> {
      return refusingDeniedAccess(() =>
        database.transaction(async (transaction) => {
          installActorContext(transaction, actor);
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
      const { token, prefix, secretHash } = await newAgentCredentialSecret();

      return refusingDeniedAccess(() =>
        database.transaction(async (transaction) => {
          installActorContext(transaction, actor);
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
      return refusingDeniedAccess(() =>
        database.transaction(async (transaction) => {
          installActorContext(transaction, actor);
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

    async revokeAgentCredential(actor: ActorContext, credentialId: string): Promise<boolean> {
      return database.transaction(async (transaction) => {
        installActorContext(transaction, actor);
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
        installActorContext(transaction, actor);
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
