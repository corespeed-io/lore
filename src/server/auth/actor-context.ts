import type { PostgresTransaction } from "@corespeed/lore-core";

export interface ActorContext {
  workspaceId: string;
  userId: string;
  agentId?: string;
}

export interface UserContext {
  userId: string;
}

/**
 * Bind the RLS identity of a User acting outside any Workspace. The settings travel
 * with the transaction's next statement, so binding costs no round trip.
 */
export function installUserContext(transaction: PostgresTransaction, user: UserContext): void {
  transaction.setLocal({
    "lore.workspace_id": "",
    "lore.user_id": user.userId,
    "lore.agent_id": "",
  });
}

/**
 * Bind the RLS identity of an Actor in its Workspace. Every setting is written, so
 * a transaction never keeps another Actor's values.
 */
export function installActorContext(transaction: PostgresTransaction, actor: ActorContext): void {
  transaction.setLocal({
    "lore.workspace_id": actor.workspaceId,
    "lore.user_id": actor.userId,
    "lore.agent_id": actor.agentId ?? "",
  });
}
