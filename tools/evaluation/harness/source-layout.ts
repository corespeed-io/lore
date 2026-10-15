import { fileURLToPath } from "node:url";
import * as sdk from "@corespeed/lore-sdk";

/** One cited Observation from a source read, as far as the layout needs it. */
export interface LayoutSource {
  observationId: string;
  /** The Memories, among those read, that cite it. */
  memoryIds: readonly string[];
}

/** A reading order: indexes into the search results and into the read's sources. */
export type Arrangement = Array<
  { kind: "memory"; index: number } | { kind: "source"; index: number }
>;

export interface SourceLayout {
  /** This file, so a run's key covers the layout code and the SDK it loads. */
  entry: string;
  /** Which layout the checkout's code provides; part of the run's retrieval identity. */
  name: string;
  arrange(memoryIds: readonly string[], sources: readonly LayoutSource[]): Arrangement;
}

/** The SDK function that places each Memory's sources after it, where a checkout has one. */
type AttachMemorySources = (
  results: ReadonlyArray<{ memory: { id: string } }>,
  read: { sources: readonly LayoutSource[] },
) => ReadonlyArray<{ sources: readonly LayoutSource[] }>;

/**
 * The order an agent reads a Memory search and its sources in. With the SDK's
 * `attachMemorySources`, as `lore_search withSources` uses it, each Memory is
 * followed by its own sources. Without it, an agent searches and then calls
 * `lore_read_evidence`, so every Memory comes first and the sources follow in the
 * read's order. Both read the same sources.
 */
export function sourceLayoutFor(attach: unknown, entry: string): SourceLayout {
  if (typeof attach !== "function") {
    return {
      entry,
      name: "two calls: every Memory, then the source read in its order",
      arrange: (memoryIds, sources) => [
        ...memoryIds.map((_, index) => ({ kind: "memory" as const, index })),
        ...sources.map((_, index) => ({ kind: "source" as const, index })),
      ],
    };
  }
  return {
    entry,
    name: "sdk attachMemorySources: each Memory, then its sources",
    arrange(memoryIds, sources) {
      const attached = (attach as AttachMemorySources)(
        memoryIds.map((id) => ({ memory: { id } })),
        { sources },
      );
      if (!Array.isArray(attached) || attached.length !== memoryIds.length) {
        throw new Error("attachMemorySources must return one entry per search result");
      }
      const position = new Map(sources.map((source, index) => [source.observationId, index]));
      const used = new Set<number>();
      const arrangement: Arrangement = [];
      for (const [index, entry] of attached.entries()) {
        arrangement.push({ kind: "memory", index });
        for (const source of entry.sources) {
          const sourceIndex = position.get(source.observationId);
          if (sourceIndex === undefined || used.has(sourceIndex)) {
            throw new Error(`attachMemorySources placed ${source.observationId} wrongly`);
          }
          used.add(sourceIndex);
          arrangement.push({ kind: "source", index: sourceIndex });
        }
      }
      return arrangement;
    },
  };
}

// A ref from before the SDK had it lacks the export, so it is looked up, not imported.
export const sourceLayout = sourceLayoutFor(
  (sdk as Record<string, unknown>).attachMemorySources,
  fileURLToPath(import.meta.url),
);
