import type {
  MemoryStorageContext,
  MemoryStorageScope,
  PostgresDatabase,
  PostgresTransaction,
} from "@corespeed/lore-core";
import { actorTransaction, PendingActor, type RequestActor } from "@/server/auth/actor-admission";
import type { ActorContext } from "@/server/auth/actor-context";

function admitted(actor: RequestActor): ActorContext {
  const bound = actor instanceof PendingActor ? actor.actor : actor;
  // The engine reads owner and source keys only after its first statements, which
  // carry a pending Actor's admission, have returned.
  if (!bound) throw new Error("The Actor is read before its admission returned");
  return bound;
}

/**
 * The storage keys of a request's Actor. The owner and source keys are read only
 * once its admission has returned; the partition (its Workspace) is known before.
 */
export function memoryStorageScope(actor: RequestActor): MemoryStorageScope {
  return {
    partitionId: actor.workspaceId,
    get ownerId() {
      return admitted(actor).userId;
    },
    get sourceId() {
      return admitted(actor).agentId;
    },
  };
}

/**
 * OSS establishes identity inside every transaction, not only the first read. A
 * pending Actor is admitted as the prefix of the first one (`actorTransaction`).
 */
export function createMemoryStorage(
  database: PostgresDatabase,
  actor: RequestActor,
): MemoryStorageContext {
  const scope = memoryStorageScope(actor);
  return {
    get partitionId() {
      return scope.partitionId;
    },
    get ownerId() {
      return scope.ownerId;
    },
    get sourceId() {
      return scope.sourceId;
    },
    database: {
      transaction: (use, options) =>
        actorTransaction(database, actor, (transaction) => use(transaction), options),
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
