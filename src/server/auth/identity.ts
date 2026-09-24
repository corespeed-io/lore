import type { PostgresDatabase, PostgresTransaction } from "@corespeed/lore-core";
import { installUserContext } from "@/server/auth/actor-context";

export interface User {
  id: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterIdentity {
  provider: string;
  subject: string;
  displayName: string;
  email?: string;
}

interface UserRow {
  id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function registerInTransaction(
  transaction: PostgresTransaction,
  identity: RegisterIdentity,
): Promise<User> {
  const result = await transaction.query<UserRow>(
    "SELECT * FROM lore.register_identity($1, $2, $3, $4, $5, $6)",
    [
      crypto.randomUUID(),
      crypto.randomUUID(),
      identity.provider,
      identity.subject,
      identity.displayName,
      identity.email ?? "",
    ],
  );
  return toUser(result.rows[0]);
}

export function createIdentityModule(database: PostgresDatabase) {
  return {
    async register(identity: RegisterIdentity): Promise<User> {
      return database.transaction((transaction) => registerInTransaction(transaction, identity));
    },

    /**
     * Register the verified identity and test its active Membership in exactly one
     * Workspace, in one transaction. Suspended, revoked, and unknown Workspaces all
     * report `activeMember: false`.
     */
    async registerInWorkspace(
      identity: RegisterIdentity,
      workspaceId: string,
    ): Promise<{ activeMember: boolean; user: User }> {
      return database.transaction(async (transaction) => {
        const user = await registerInTransaction(transaction, identity);
        await installUserContext(transaction, { userId: user.id });
        const membership = await transaction.query<{ active: boolean }>(
          "SELECT lore.is_active_member($1) AS active",
          [workspaceId],
        );
        return { activeMember: membership.rows[0]?.active === true, user };
      });
    },

    async resolve(provider: string, subject: string): Promise<User | null> {
      return database.transaction(async (transaction) => {
        const result = await transaction.query<UserRow>(
          "SELECT * FROM lore.resolve_identity($1, $2)",
          [provider, subject],
        );
        return result.rows[0] ? toUser(result.rows[0]) : null;
      });
    },
  };
}
