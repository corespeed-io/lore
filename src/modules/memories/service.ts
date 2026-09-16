import {
  memoryFromRow as coreMemoryFromRow,
  createMemoryModule as createCoreMemoryModule,
  createMemoryMutationPrimitives as createCoreMutationPrimitives,
  isPostgresAccessDenied,
  type ListMemory,
  MemoryAccessDeniedError,
  type MemoryModuleOptions,
  type MemoryMutationPrimitivesOptions,
  type MemoryRow,
  MemoryVersionConflictError,
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
import { type ActorContext, installActorContext } from "@/server/auth/actor-context";
import { createMemoryStorage, memoryStorageInTransaction } from "@/server/database/memory-storage";
import {
  beginMutation,
  completeMutation,
  type IdempotencyRequest,
} from "@/server/http/idempotency";

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
    notifyMaintenance: primitives.notifyMaintenance,
    async insertMemoryInTransaction(
      transaction: PostgresTransaction,
      actor: ActorContext,
      input: RememberMemory,
      createdByAgentId: string | null = actor.agentId ?? null,
    ) {
      const result = await primitives.insertMemoryInTransaction(
        transaction,
        memoryStorageInTransaction(transaction, actor),
        input,
        createdByAgentId,
      );
      return { ...result, memory: memoryFromStorage(result.memory) };
    },
    async updateMemoryInTransaction(
      transaction: PostgresTransaction,
      actor: ActorContext,
      id: string,
      input: UpdateMemory,
      expectedVersion?: number,
    ) {
      const writable = await transaction.query<{ id: string }>(
        `SELECT id FROM memories WHERE id = $1 AND workspace_id = $2
         AND lore.can_write_memory(workspace_id, owner_user_id) FOR UPDATE`,
        [id, actor.workspaceId],
      );
      if (!writable.rows[0]) return null;
      const result = await primitives.updateMemoryInTransaction(
        transaction,
        memoryStorageInTransaction(transaction, actor),
        id,
        input,
        expectedVersion,
      );
      return result ? { ...result, memory: memoryFromStorage(result.memory) } : null;
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
  const { insertMemoryInTransaction, updateMemoryInTransaction, notifyMaintenance } =
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
          await installActorContext(transaction, actor);
          const claim = await beginMutation<{ memory: Memory }>(
            transaction,
            actor,
            options.idempotency,
          );
          if (claim.replay) {
            return { memory: claim.replay.body.memory, jobId: null, replayed: true };
          }
          const access = await transaction.query<{ allowed: boolean }>(
            "SELECT lore.can_write_memory($1, $2) AS allowed",
            [actor.workspaceId, actor.userId],
          );
          if (access.rows[0]?.allowed !== true) {
            throw new MemoryAccessDeniedError("Actor cannot create Memory in this Workspace");
          }
          const inserted = await insertMemoryInTransaction(transaction, actor, input);
          await completeMutation(
            transaction,
            claim.requestId,
            201,
            { memory: inserted.memory },
            Boolean(options.idempotency),
          );
          return { ...inserted, replayed: false };
        });
        if (!created.replayed) notifyMaintenance(created.jobId);
        return created.memory;
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
        await installActorContext(transaction, actor);
        const claim = await beginMutation<{ memory: Memory | null }>(
          transaction,
          actor,
          options.idempotency,
        );
        if (claim.replay) {
          return { memory: claim.replay.body.memory, jobId: null, chunksChanged: false };
        }
        const updated = await updateMemoryInTransaction(
          transaction,
          actor,
          id,
          input,
          options.expectedVersion,
        );
        if (!updated) {
          await completeMutation(
            transaction,
            claim.requestId,
            404,
            { memory: null },
            Boolean(options.idempotency),
          );
          return { memory: null, jobId: null, chunksChanged: false };
        }
        await completeMutation(
          transaction,
          claim.requestId,
          200,
          { memory: updated.memory },
          Boolean(options.idempotency),
        );
        return updated;
      });
      // Metadata-only updates can leave an existing stale job for the scheduled
      // sweep without billing a Queue message for an already-embedded Memory.
      notifyMaintenance(updatedResult.chunksChanged ? updatedResult.jobId : null);
      return updatedResult.memory;
    },

    async forget(
      actor: ActorContext,
      id: string,
      options: MemoryMutationOptions = {},
    ): Promise<boolean> {
      return database.transaction(async (transaction) => {
        await installActorContext(transaction, actor);
        const claim = await beginMutation<{ deleted: boolean }>(
          transaction,
          actor,
          options.idempotency,
        );
        if (claim.replay) return claim.replay.body.deleted;
        const current = await transaction.query<{ version: number }>(
          `SELECT version
           FROM memories
           WHERE id = $1
             AND workspace_id = $2
             AND lore.can_write_memory(workspace_id, owner_user_id)
           FOR UPDATE`,
          [id, actor.workspaceId],
        );
        const currentVersion = current.rows[0]?.version;
        if (currentVersion === undefined) {
          await completeMutation(
            transaction,
            claim.requestId,
            404,
            { deleted: false },
            Boolean(options.idempotency),
          );
          return false;
        }
        if (options.expectedVersion !== undefined && currentVersion !== options.expectedVersion) {
          throw new MemoryVersionConflictError(options.expectedVersion, currentVersion);
        }
        const result = await transaction.query<{ id: string }>(
          `DELETE FROM memories
           WHERE id = $1 AND workspace_id = $2 AND version = $3
           RETURNING id`,
          [id, actor.workspaceId, currentVersion],
        );
        const deleted = result.rows.length === 1;
        await completeMutation(
          transaction,
          claim.requestId,
          deleted ? 204 : 404,
          { deleted },
          Boolean(options.idempotency),
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
