import type { PostgresTransaction } from "./db";

export interface ActorContext {
  workspaceId: string;
  userId: string;
  agentId?: string;
}

export interface UserContext {
  userId: string;
}

export async function installUserContext(
  transaction: PostgresTransaction,
  user: UserContext,
): Promise<void> {
  await transaction.query(
    `SELECT
       set_config('lore.workspace_id', '', true),
       set_config('lore.user_id', $1, true),
       set_config('lore.agent_id', '', true)`,
    [user.userId],
  );
}

export async function installActorContext(
  transaction: PostgresTransaction,
  actor: ActorContext,
): Promise<void> {
  await transaction.query(
    `SELECT
       set_config('lore.workspace_id', $1, true),
       set_config('lore.user_id', $2, true),
       set_config('lore.agent_id', $3, true)`,
    [actor.workspaceId, actor.userId, actor.agentId ?? ""],
  );
}
