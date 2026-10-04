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
  type PostgresBatchOptions,
  type PostgresDatabase,
  type PostgresTransaction,
  type RememberMemory,
  type SearchMemory,
  type Memory as StoredMemory,
  type MemorySearchResult as StoredMemorySearchResult,
  type UpdateMemory,
  type MemoryMutationOptions as VersionOptions,
  validatedEmbeddingDimensions,
} from "@corespeed/lore-core";
import { beginMutation, completeMutation, type IdempotencyRequest } from "@/server/api/idempotency";
import { type ActorContext, installActorContext } from "@/server/auth/actor-context";
import { createMemoryStorage, memoryStorageInTransaction } from "@/server/database/memory-storage";

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
      batchOptions: PostgresBatchOptions = {},
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
      batchOptions: PostgresBatchOptions = {},
    ) {
      const result = await primitives.updateMemoryInTransaction(
        transaction,
        memoryStorageInTransaction(transaction, actor),
        id,
        input,
        expectedVersion,
        batchOptions,
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

/** Product orchestration: actor identity, write policy, replay and post-commit delivery. */
export function createMemoryModule(database: PostgresDatabase, options: MemoryModuleOptions = {}) {
  const dimensions = validatedEmbeddingDimensions(
    options.embeddingDimensions ?? options.embeddingProvider?.dimensions ?? 1024,
  );
  if (options.embeddingProvider && options.embeddingProvider.dimensions !== dimensions) {
    throw new Error(
      "embeddingDimensions must match embeddingProvider.dimensions: " +
        `the module is configured for ${dimensions} but the provider embeds at ${options.embeddingProvider.dimensions}`,
    );
  }
  const { forgetMemoryInTransaction, insertMemoryInTransaction, updateMemoryInTransaction } =
    createMemoryMutationPrimitives(options);
  const coreFor = (actor: ActorContext) =>
    createCoreMemoryModule(createMemoryStorage(database, actor), options);
  return {
    async remember(
      actor: ActorContext,
      input: RememberMemory,
      options: MemoryMutationOptions = {},
    ): Promise<Memory> {
      try {
        const created = await database.transaction(async (transaction) => {
          installActorContext(transaction, actor);
          const claim = await beginMutation<{ memory: Memory }>(
            transaction,
            actor,
            options.idempotency,
          );
          if (claim.replay) return claim.replay.memory;
          // The memories_insert policy enforces write authority; a refusal is
          // SQLSTATE 42501, answered below as MemoryAccessDeniedError. Without a
          // ledger row to complete, COMMIT travels with the insert.
          const inserted = await insertMemoryInTransaction(transaction, actor, input, undefined, {
            commit: !options.idempotency,
          });
          await completeMutation(
            transaction,
            claim.requestId,
            "created",
            { memory: inserted.memory },
            Boolean(options.idempotency),
            { commit: true },
          );
          return inserted.memory;
        });
        return created;
      } catch (error) {
        if (isPostgresAccessDenied(error)) {
          throw new MemoryAccessDeniedError("Actor cannot create Memory in this Workspace", {
            cause: error,
          });
        }
        throw error;
      }
    },

    async retrieve(actor: ActorContext, id: string): Promise<Memory | null> {
      const memory = await coreFor(actor).retrieve(id);
      return memory ? memoryFromStorage(memory) : null;
    },

    async update(
      actor: ActorContext,
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
      const updatedResult = await database.transaction(async (transaction) => {
        installActorContext(transaction, actor);
        const claim = await beginMutation<{ memory: Memory | null }>(
          transaction,
          actor,
          options.idempotency,
        );
        if (claim.replay) return claim.replay.memory;
        const updated = await updateMemoryInTransaction(
          transaction,
          actor,
          id,
          input,
          options.expectedVersion,
          { commit: !options.idempotency },
        );
        if (!updated) {
          await completeMutation(
            transaction,
            claim.requestId,
            "not_found",
            { memory: null },
            Boolean(options.idempotency),
            { commit: true },
          );
          return null;
        }
        await completeMutation(
          transaction,
          claim.requestId,
          "ok",
          { memory: updated.memory },
          Boolean(options.idempotency),
          { commit: true },
        );
        return updated.memory;
      });
      return updatedResult;
    },

    async forget(
      actor: ActorContext,
      id: string,
      options: MemoryMutationOptions = {},
    ): Promise<boolean> {
      return database.transaction(async (transaction) => {
        installActorContext(transaction, actor);
        const claim = await beginMutation<{ deleted: boolean }>(
          transaction,
          actor,
          options.idempotency,
        );
        if (claim.replay) return claim.replay.deleted;
        // Write authority is checked before the version, so a Memory this Actor may
        // not write reads as absent rather than as a version conflict.
        const deleted = await forgetMemoryInTransaction(
          transaction,
          actor,
          id,
          options.expectedVersion,
          { commit: !options.idempotency },
        );
        await completeMutation(
          transaction,
          claim.requestId,
          deleted ? "deleted" : "not_found",
          { deleted },
          Boolean(options.idempotency),
          { commit: true },
        );
        return deleted;
      });
    },

    async list(actor: ActorContext, input: ListMemory = {}): Promise<Memory[]> {
      return (await coreFor(actor).list(input)).map(memoryFromStorage);
    },
    async search(actor: ActorContext, input: SearchMemory): Promise<MemorySearchResult[]> {
      return (await coreFor(actor).search(input)).map((result) => ({
        ...result,
        memory: memoryFromStorage(result.memory),
      }));
    },
  };
}
