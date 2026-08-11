import { sql } from "drizzle-orm";
import type { LoreTransaction } from "./db";

export interface ActorContext {
  workspaceId: string;
  userId: string;
  agentId?: string;
}

export interface UserContext {
  userId: string;
}

export async function installUserContext(
  transaction: LoreTransaction,
  user: UserContext,
): Promise<void> {
  await transaction.execute(
    sql`SELECT
       set_config('lore.workspace_id', '', true),
       set_config('lore.user_id', ${user.userId}, true),
       set_config('lore.agent_id', '', true)`,
  );
}

export async function installActorContext(
  transaction: LoreTransaction,
  actor: ActorContext,
): Promise<void> {
  await transaction.execute(
    sql`SELECT
       set_config('lore.workspace_id', ${actor.workspaceId}, true),
       set_config('lore.user_id', ${actor.userId}, true),
       set_config('lore.agent_id', ${actor.agentId ?? ""}, true)`,
  );
}
