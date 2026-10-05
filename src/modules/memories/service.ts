import {
  memoryFromRow as coreMemoryFromRow,
  createMemoryModule as createCoreMemoryModule,
  createMemoryMutationPrimitives as createCoreMutationPrimitives,
  type InsertMemoryRecord,
  isPostgresAccessDenied,
  type ListMemory,
  MemoryAccessDeniedError,
  type MemoryModuleOptions,
  type MemoryMutationPrimitivesOptions,
  type MemoryRow,
  type MemoryUpdateBatchOptions,
  type MemoryWriteBatchOptions,
  memorySelectColumns,
  type PostgresBatchOptions,
  type PostgresDatabase,
  type PostgresTransaction,
  type RememberMemory,
  type SearchMemory,
  type Memory as StoredMemory,
  type MemorySearchResult as StoredMemorySearchResult,
  type UpdateMemory,
  type MemoryMutationOptions as VersionOptions,
  validateMemoryMetadata,
  validateMemoryScope,
  type WrittenMemory,
} from "@corespeed/lore-core";
import {
  beginMutation,
  completionStatement,
  conditionalCompletionStatements,
  type IdempotencyRequest,
  type SqlReplayBody,
} from "@/server/api/idempotency";
import {
  actorTransaction,
  admittedActor,
  PendingActor,
  type RequestActor,
} from "@/server/auth/actor-admission";
import type { ActorContext } from "@/server/auth/actor-context";
import {
  createMemoryStorage,
  memoryStorageInTransaction,
  memoryStorageScope,
} from "@/server/database/memory-storage";

export interface Memory extends Omit<StoredMemory, "partitionId" | "ownerId" | "sourceId"> {
  workspaceId: string;
  ownerUserId: string;
  createdByAgentId: string | null;
}

export interface MemorySearchResult extends Omit<StoredMemorySearchResult, "memory"> {
  memory: Memory;
}

export interface MemoryMutationOptions extends VersionOptions {
  idempotency?: IdempotencyRequest;
}

function memoryFromStorage(memory: StoredMemory): Memory {
  const { partitionId, ownerId, sourceId, ...record } = memory;
  return { ...record, workspaceId: partitionId, ownerUserId: ownerId, createdByAgentId: sourceId };
}

export function memoryFromRow(row: MemoryRow): Memory {
  return memoryFromStorage(coreMemoryFromRow(row));
}

/** OSS write policy remains inside the transaction and precedes version checks. */
export function createMemoryMutationPrimitives(options: MemoryMutationPrimitivesOptions = {}) {
  const primitives = createCoreMutationPrimitives(options);
  return {
    /** Batch-insert Memories owned by the Actor's User, with chunks and embedding jobs. */
    insertMemoriesInTransaction(
      transaction: PostgresTransaction,
      actor: ActorContext,
      records: readonly InsertMemoryRecord[],
    ) {
      return primitives.insertMemoriesInTransaction(
        transaction,
        memoryStorageInTransaction(transaction, actor),
        records,
      );
    },
    async insertMemoryInTransaction(
      transaction: PostgresTransaction,
      actor: ActorContext,
      input: RememberMemory,
      createdByAgentId: string | null = actor.agentId ?? null,
      batchOptions: MemoryWriteBatchOptions = {},
    ) {
      const result = await primitives.insertMemoryInTransaction(
        transaction,
        memoryStorageInTransaction(transaction, actor),
        input,
        createdByAgentId,
        batchOptions,
      );
      return { ...result, memory: memoryFromStorage(result.memory) };
    },
    /**
     * Null when the Memory is absent or this Actor may not write it: the engine's
     * locking read applies the update policy under RLS before any version check.
     */
    async updateMemoryInTransaction(
      transaction: PostgresTransaction,
      actor: ActorContext,
      id: string,
      input: UpdateMemory,
      expectedVersion?: number,
      options: MemoryUpdateBatchOptions = {},
    ) {
      const result = await primitives.updateMemoryInTransaction(
        transaction,
        memoryStorageInTransaction(transaction, actor),
        id,
        input,
        expectedVersion,
        options,
      );
      return result ? { ...result, memory: memoryFromStorage(result.memory) } : null;
    },
    /**
     * False when the Memory is absent or this Actor may not write it: RLS skips such
     * a row in the engine's delete and in its version read alike, so a Memory this
     * Actor may not write reads as absent rather than as a version conflict.
     */
    async forgetMemoryInTransaction(
      transaction: PostgresTransaction,
      actor: ActorContext,
      id: string,
      expectedVersion?: number,
      batchOptions: PostgresBatchOptions = {},
    ): Promise<boolean> {
      return primitives.forgetMemoryInTransaction(
        transaction,
        memoryStorageInTransaction(transaction, actor),
        id,
        { expectedVersion, ...batchOptions },
      );
    },
  };
}

/**
 * The wire Memory of the row a keyed write has just written, built by PostgreSQL
 * as the ledger completion runs, so the completion travels in the write's own
 * batch. It is `memoryFromRow` in SQL; tests hold the two equal.
 */
export function writtenMemoryReplayBody(workspaceId: string, memoryId: string): SqlReplayBody {
  return {
    sql: (p) => `(SELECT jsonb_build_object('memory', jsonb_build_object(
             'id', memory.id,
             'workspaceId', memory.workspace_id,
             'ownerUserId', memory.owner_user_id,
             'createdByAgentId', memory.created_by_agent_id,
             'scope', memory.scope,
             'content', memory.content,
             'metadata', memory.metadata,
             'version', memory.version,
             'createdAt', memory.created_at,
             'updatedAt', memory.updated_at))
           FROM (
             SELECT ${memorySelectColumns()}
             FROM memories
             WHERE workspace_id = ${p(workspaceId)} AND id = ${p(memoryId)}
           ) AS memory)`,
    subjects: { memory: { id: memoryId } },
  };
}

/**
 * The ledger completion of a keyed Memory write, sent in the write's own batch. It
 * records the write's outcome only when the Memory is as the write meant to leave
 * it, at the written version or gone; a write that matched no row (the Actor lost
 * write authority after its lock) is recorded as not_found, which is also what the
 * first response said, so a replay never claims a write that did not happen.
 */
function memoryWriteCompletion(
  requestId: string,
  workspaceId: string,
  written: WrittenMemory,
  outcome: "created" | "ok" | "deleted",
) {
  const deleted = outcome === "deleted";
  return conditionalCompletionStatements(
    requestId,
    (p) =>
      written.version === null
        ? `NOT EXISTS (SELECT 1 FROM memories WHERE workspace_id = ${p(workspaceId)} AND id = ${p(written.id)})`
        : `EXISTS (SELECT 1 FROM memories WHERE workspace_id = ${p(workspaceId)} AND id = ${p(written.id)} AND version = ${p(written.version)}::integer)`,
    {
      outcome,
      body: deleted ? { deleted: true } : writtenMemoryReplayBody(workspaceId, written.id),
    },
    { outcome: "not_found", body: deleted ? { deleted: false } : { memory: null } },
  );
}

/**
 * Product orchestration: actor identity, write policy, replay and post-commit
 * delivery. A pending Actor is admitted as the prefix of each operation's first
 * transaction, and a keyed write claims its ledger row in that same round trip:
 * reads take one round trip, writes two (`docs/research/lore-core-db-wave-spec.md`).
 */
export function createMemoryModule(database: PostgresDatabase, options: MemoryModuleOptions = {}) {
  const primitives = createCoreMutationPrimitives(options);
  const coreFor = (actor: RequestActor) =>
    createCoreMemoryModule(createMemoryStorage(database, actor), options);
  // An Agent's token is proved only in the database, so a search that pays a
  // provider before its first transaction admits the Agent first. A human's
  // credential was verified before the request reached here.
  const searchCallsProviderFirst = Boolean(
    options.embeddingProvider || options.queryPlanningProvider,
  );
  return {
    async remember(
      actor: RequestActor,
      input: RememberMemory,
      options: MemoryMutationOptions = {},
    ): Promise<Memory> {
      const keyed = Boolean(options.idempotency);
      try {
        return await actorTransaction(database, actor, async (transaction, admitted) => {
          const claim = await beginMutation<{ memory: Memory }>(transaction, options.idempotency);
          const bound = await admitted;
          if (claim.replay) return claim.replay.memory;
          // The memories_insert policy enforces write authority; a refusal is
          // SQLSTATE 42501, answered below as MemoryAccessDeniedError. The ledger
          // completion and COMMIT travel with the insert.
          const inserted = await primitives.insertMemoryInTransaction(
            transaction,
            memoryStorageInTransaction(transaction, bound),
            input,
            bound.agentId ?? null,
            {
              commit: true,
              ...(keyed
                ? {
                    finish: (written: WrittenMemory) =>
                      memoryWriteCompletion(claim.requestId, bound.workspaceId, written, "created"),
                  }
                : {}),
            },
          );
          return memoryFromStorage(inserted.memory);
        });
      } catch (error) {
        if (isPostgresAccessDenied(error)) {
          throw new MemoryAccessDeniedError("Actor cannot create Memory in this Workspace", {
            cause: error,
          });
        }
        throw error;
      }
    },

    async retrieve(actor: RequestActor, id: string): Promise<Memory | null> {
      const memory = await coreFor(actor).retrieve(id);
      return memory ? memoryFromStorage(memory) : null;
    },

    async update(
      actor: RequestActor,
      id: string,
      input: UpdateMemory,
      options: MemoryMutationOptions = {},
    ): Promise<Memory | null> {
      if (
        input.content === undefined &&
        input.scope === undefined &&
        input.metadata === undefined
      ) {
        return this.retrieve(actor, id);
      }
      // Refused before any statement, as the engine's own update refuses it.
      if (input.scope !== undefined) validateMemoryScope(input.scope);
      if (input.metadata !== undefined) validateMemoryMetadata(input.metadata);
      const keyed = Boolean(options.idempotency);
      try {
        return await actorTransaction(database, actor, async (transaction, admitted) => {
          // The claim and the locking read share the admission's round trip. Write
          // authority is checked by the locking read, before the version.
          const claimed = beginMutation<{ memory: Memory | null }>(
            transaction,
            options.idempotency,
          );
          const locking = primitives.lockMemoryInTransaction(
            transaction,
            memoryStorageScope(actor),
            id,
            input,
          );
          locking.catch(() => undefined);
          const claim = await claimed;
          const bound = await admitted;
          if (claim.replay) return claim.replay.memory;
          const locked = await locking;
          if (!locked) {
            if (keyed) {
              await transaction.batch(
                [completionStatement(claim.requestId, "not_found", { memory: null })],
                { commit: true },
              );
            }
            return null;
          }
          const updated = await primitives.updateLockedMemoryInTransaction(
            transaction,
            memoryStorageInTransaction(transaction, bound),
            locked,
            options.expectedVersion,
            {
              commit: true,
              ...(keyed
                ? {
                    finish: (written: WrittenMemory) =>
                      memoryWriteCompletion(claim.requestId, bound.workspaceId, written, "ok"),
                  }
                : {}),
            },
          );
          return updated ? memoryFromStorage(updated.memory) : null;
        });
      } catch (error) {
        // Write authority revoked after the lock: the store refuses the batch's chunk
        // rewrite (42501) and the transaction, ledger claim included, rolls back. It
        // reads like any Memory this Actor may not write, and a retry with the same
        // key runs afresh.
        if (isPostgresAccessDenied(error)) return null;
        throw error;
      }
    },

    async forget(
      actor: RequestActor,
      id: string,
      options: MemoryMutationOptions = {},
    ): Promise<boolean> {
      if (!options.idempotency) {
        // The delete, its version read, and COMMIT all travel with the admission.
        // RLS skips a Memory this Actor may not write in the delete and its version
        // read alike, so it reads as absent rather than as a version conflict.
        return actorTransaction(database, actor, async (transaction, admitted) => {
          await beginMutation(transaction);
          const deleting = primitives.forgetMemoryInTransaction(
            transaction,
            memoryStorageScope(actor),
            id,
            { expectedVersion: options.expectedVersion, commit: true },
          );
          deleting.catch(() => undefined);
          await admitted;
          return deleting;
        });
      }
      const idempotency = options.idempotency;
      return actorTransaction(database, actor, async (transaction, admitted) => {
        // The claim and the locking read share the admission's round trip; the
        // delete waits for the claim, so a replay deletes nothing and a reclaimed
        // key's events carry the ledger row's request id.
        const claimed = beginMutation<{ deleted: boolean }>(transaction, idempotency);
        // Locked for no update: the read compares and fetches nothing else.
        const locking = primitives.lockMemoryInTransaction(
          transaction,
          memoryStorageScope(actor),
          id,
          {},
        );
        locking.catch(() => undefined);
        const claim = await claimed;
        await admitted;
        if (claim.replay) return claim.replay.deleted;
        const locked = await locking;
        if (!locked) {
          await transaction.batch(
            [completionStatement(claim.requestId, "not_found", { deleted: false })],
            { commit: true },
          );
          return false;
        }
        return primitives.forgetLockedMemoryInTransaction(
          transaction,
          memoryStorageScope(actor),
          locked,
          options.expectedVersion,
          {
            commit: true,
            finish: (written) =>
              memoryWriteCompletion(claim.requestId, actor.workspaceId, written, "deleted"),
          },
        );
      });
    },

    async list(actor: RequestActor, input: ListMemory = {}): Promise<Memory[]> {
      return (await coreFor(actor).list(input)).map(memoryFromStorage);
    },
    async search(actor: RequestActor, input: SearchMemory): Promise<MemorySearchResult[]> {
      const searching =
        actor instanceof PendingActor && actor.kind === "agent" && searchCallsProviderFirst
          ? await admittedActor(database, actor)
          : actor;
      return (await coreFor(searching).search(input)).map((result) => ({
        ...result,
        memory: memoryFromStorage(result.memory),
      }));
    },
  };
}
