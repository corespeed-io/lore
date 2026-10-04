import {
  type ConnectMemories,
  createMemoryGraphModule as createCoreMemoryGraphModule,
  type DisconnectMemories,
  isPostgresAccessDenied,
  type ListMemoryLinks,
  type MemoryGraph,
  type PostgresDatabase,
  type ReadMemoryGraph,
  type MemoryLink as StoredMemoryLink,
} from "@corespeed/lore-core";
import type { RequestActor } from "@/server/auth/actor-admission";
import { createMemoryStorage } from "@/server/database/memory-storage";

export interface MemoryLink extends Omit<StoredMemoryLink, "partitionId"> {
  workspaceId: string;
}

export interface ConnectedMemoryLink {
  link: MemoryLink;
  created: boolean;
}

/**
 * A write that loses a race with its target: the target became invisible (the RLS
 * check refuses the row) or was deleted (its foreign key is gone) after the engine
 * saw it. Either reads exactly like a target that was never visible.
 */
function isVanishedEndpoint(error: unknown): boolean {
  return (
    isPostgresAccessDenied(error) ||
    (error instanceof Error && "code" in error && error.code === "23503")
  );
}

/**
 * OSS binds Workspace visibility and endpoint write policies to graph storage.
 * The engine locks the source for writing and reads the target through RLS, so
 * `lore.can_write_memory` decides the source (memories_update) and
 * `lore.can_read_memory` the target (memories_select): a source this Actor may not
 * write and a target it cannot read are both absent.
 */
export function createMemoryGraphModule(database: PostgresDatabase) {
  const coreFor = (actor: RequestActor) =>
    createCoreMemoryGraphModule(createMemoryStorage(database, actor));
  return {
    /** Null when the source is not writable or the target is not visible to this Actor. */
    async connect(
      actor: RequestActor,
      input: ConnectMemories,
    ): Promise<ConnectedMemoryLink | null> {
      try {
        const connected = await coreFor(actor).connect(input);
        if (!connected) return null;
        const { partitionId, ...link } = connected.link;
        return { link: { ...link, workspaceId: partitionId }, created: connected.created };
      } catch (error) {
        if (isVanishedEndpoint(error)) return null;
        throw error;
      }
    },

    /** False when no such Link is visible to this Actor through a source it may write. */
    async disconnect(actor: RequestActor, input: DisconnectMemories): Promise<boolean> {
      return coreFor(actor).disconnect(input);
    },

    /** One page of a Memory's visible Links; null when the Memory is not visible. */
    async list(actor: RequestActor, input: ListMemoryLinks): Promise<MemoryLink[] | null> {
      const links = await coreFor(actor).list(input);
      return (
        links?.map(({ partitionId, ...link }) => ({ ...link, workspaceId: partitionId })) ?? null
      );
    },

    read(actor: RequestActor, input: ReadMemoryGraph = {}): Promise<MemoryGraph> {
      return coreFor(actor).read(input);
    },
  };
}
