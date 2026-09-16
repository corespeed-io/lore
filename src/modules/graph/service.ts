import {
  type ConnectMemories,
  createMemoryGraphModule as createCoreMemoryGraphModule,
  type MemoryGraph,
  type PostgresDatabase,
  type ReadMemoryGraph,
  type MemoryLink as StoredMemoryLink,
} from "@corespeed/lore-core";
import type { ActorContext } from "@/server/auth/actor-context";
import { createMemoryStorage } from "@/server/database/memory-storage";

export type {
  ConnectMemories,
  MemoryGraph,
  MemoryGraphLink,
  MemoryGraphNode,
  ReadMemoryGraph,
} from "@corespeed/lore-core";

export interface MemoryLink extends Omit<StoredMemoryLink, "partitionId"> {
  workspaceId: string;
}

/** OSS binds Workspace visibility and endpoint write policies to graph storage. */
export function createMemoryGraphModule(database: PostgresDatabase) {
  return {
    async connect(actor: ActorContext, input: ConnectMemories): Promise<MemoryLink> {
      const { partitionId, ...link } = await createCoreMemoryGraphModule(
        createMemoryStorage(database, actor),
      ).connect(input);
      return { ...link, workspaceId: partitionId };
    },

    read(actor: ActorContext, input: ReadMemoryGraph = {}): Promise<MemoryGraph> {
      return createCoreMemoryGraphModule(createMemoryStorage(database, actor)).read(input);
    },
  };
}
