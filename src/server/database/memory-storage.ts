import type {
  MemoryStorageContext,
  PostgresDatabase,
  PostgresTransaction,
} from "@corespeed/lore-core";
import { type ActorContext, installActorContext } from "@/server/auth/actor-context";

/** OSS establishes identity inside every transaction, not only the first read. */
export function createMemoryStorage(
  database: PostgresDatabase,
  actor: ActorContext,
): MemoryStorageContext {
  return {
    partitionId: actor.workspaceId,
    ownerId: actor.userId,
    ...(actor.agentId ? { sourceId: actor.agentId } : {}),
    database: {
      transaction: (use) =>
        database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          return use(transaction);
        }),
    },
  };
}

/** The caller owns identity, authorization, commit and post-commit notification. */
export function memoryStorageInTransaction(
  transaction: PostgresTransaction,
  actor: ActorContext,
): MemoryStorageContext {
  return {
    partitionId: actor.workspaceId,
    ownerId: actor.userId,
    ...(actor.agentId ? { sourceId: actor.agentId } : {}),
    database: { transaction: (use) => use(transaction) },
  };
}
