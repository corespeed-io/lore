import { fileURLToPath } from "node:url";
import * as sdk from "@corespeed/lore-sdk";

/** One cited Observation from a source read, as far as the layout needs it. */
export interface LayoutSource {
  observationId: string;
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
  read: { sources: readonly LayoutSource[]; omittedObservationIds: readonly string[] },
) => ReadonlyArray<{ sources: readonly LayoutSource[] }>;

// A ref from before the SDK had it lacks the export, so it is looked up, not imported.
const exported: unknown = (sdk as Record<string, unknown>).attachMemorySources;

/**
 * The order an agent reads a Memory search and its sources in, under the code
 * checked out here. With the SDK's `attachMemorySources`, as `lore_search
 * withSources` uses it, each Memory is followed by its own sources. Without it,
 * an agent searches and then calls `lore_read_evidence`, so every Memory comes
 * first and the sources follow in the read's order. Both read the same sources.
 */
export const sourceLayout: SourceLayout = {
  entry: fileURLToPath(import.meta.url),
  name:
    typeof exported === "function"
      ? "sdk attachMemorySources: each Memory, then its sources"
      : "two calls: every Memory, then the source read in its order",
  arrange(memoryIds, sources) {
    if (typeof exported !== "function") {
      return [
        ...memoryIds.map((_, index) => ({ kind: "memory" as const, index })),
        ...sources.map((_, index) => ({ kind: "source" as const, index })),
      ];
    }
    const attached = (exported as AttachMemorySources)(
      memoryIds.map((id) => ({ memory: { id } })),
      { sources, omittedObservationIds: [] },
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
