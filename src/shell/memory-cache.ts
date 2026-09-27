import type { Memory } from "@corespeed/lore-sdk";
import type { ScopedMutator } from "swr";
import {
  removeMemoryFromPages,
  upsertMemoryPages,
  type useLoreMemories,
} from "@/modules/memories/browser/data";
import { loreKeys } from "@/shared/browser/cache-keys";

/** What a Memory write did, as far as the browser knows. */
export type MemoryChange =
  | { kind: "saved"; memory: Memory }
  | { kind: "forgotten"; memoryId: string }
  /** The outcome is unknown (an import, or a failed review of an update). */
  | { kind: "changed"; memoryId?: string };

export interface MemoryReadCaches {
  workspaceId: string;
  /** SWR's global mutate. */
  mutate: ScopedMutator;
  /** The browse list's bound mutate, which records a write it could not re-read. */
  mutateMemories: ReturnType<typeof useLoreMemories>["mutate"];
  mutateGraph: () => Promise<unknown>;
}

function isWorkspaceSearchKey(key: unknown, workspaceId: string): boolean {
  return Array.isArray(key) && key[0] === "lore" && key[1] === "search" && key[2] === workspaceId;
}

/**
 * The one path every Memory write takes through the browser cache: the detail entry,
 * the paged browse list, every cached search of the Workspace, and the Graph, all
 * of which derive from Memories. A view that is paused re-reads on resume.
 */
export async function applyMemoryChange(
  change: MemoryChange,
  caches: MemoryReadCaches,
): Promise<void> {
  const { workspaceId, mutate } = caches;
  if (change.kind === "saved") {
    await mutate(loreKeys.memory(workspaceId, change.memory.id), change.memory, {
      revalidate: false,
    });
    await caches.mutateMemories((pages) => upsertMemoryPages(pages, change.memory), {
      revalidate: true,
    });
  } else if (change.kind === "forgotten") {
    await mutate(loreKeys.memory(workspaceId, change.memoryId), undefined, { revalidate: false });
    await caches.mutateMemories((pages) => removeMemoryFromPages(pages, change.memoryId), {
      revalidate: true,
    });
  } else {
    // The Memory may have changed or gone, so no view keeps showing the old one.
    if (change.memoryId) {
      await mutate(loreKeys.memory(workspaceId, change.memoryId), undefined, { revalidate: true });
    }
    await caches.mutateMemories();
  }
  void mutate((key) => isWorkspaceSearchKey(key, workspaceId));
  void caches.mutateGraph();
}
