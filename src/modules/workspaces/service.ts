import { type PostgresDatabase, statement } from "@corespeed/lore-core";
import { type RequestUser, userTransaction } from "@/server/auth/actor-admission";
import type { ActorContext, UserContext } from "@/server/auth/actor-context";
import { installActorContext, installUserContext } from "@/server/auth/actor-context";
import { refusingDeniedAccess } from "@/server/database/access-denied";

export type MembershipRole = "owner" | "admin" | "member";
export type MembershipStatus = "active" | "suspended";

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

/** Workspaces and their Memberships, as the calling User may see and change them. */
export function createWorkspacesModule(database: PostgresDatabase) {
  /** One round trip, registering a pending User as its prefix. */
  async function listWorkspaces(user: RequestUser): Promise<WorkspaceSummary[]> {
    return userTransaction(database, user, async (transaction) => {
      const [result] = await transaction.batch(
        [statement<WorkspaceSummaryRow>("SELECT * FROM lore.list_workspaces()")],
        { commit: true },
      );
      return result.rows.map(toWorkspaceSummary);
    });
  }

  return {
    async createWorkspace(user: UserContext, input: { name: string }): Promise<Workspace> {
      return refusingDeniedAccess(() =>
        database.transaction(async (transaction) => {
          installUserContext(transaction, user);
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
      return refusingDeniedAccess(() =>
        database.transaction(async (transaction) => {
          installActorContext(transaction, actor);
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
  };
}
