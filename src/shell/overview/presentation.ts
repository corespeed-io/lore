import { displayCount, type ReadState } from "@/shared/browser/read-state";

export interface OverviewStatsInput {
  memoryCount: number;
  sourceCount: number;
  memoriesState: ReadState;
  /** False while browse is still filling pages or has stopped at its 5,000 cap. */
  memoriesComplete: boolean;
  linkCount: number;
  graphState: ReadState;
  graphCapped: boolean;
}

export interface OverviewStats {
  memories: string;
  links: string;
  sources: string;
}

/**
 * Dashboard stat values. An unknown read is "—" rather than 0, and a count from
 * an incomplete or capped read window is a lower bound ("5,000+"), never exact.
 */
export function overviewStats(input: OverviewStatsInput): OverviewStats {
  const memoriesLowerBound = !input.memoriesComplete;
  return {
    memories: displayCount(input.memoryCount, input.memoriesState, memoriesLowerBound),
    links: displayCount(input.linkCount, input.graphState, input.graphCapped),
    sources: displayCount(input.sourceCount, input.memoriesState, memoriesLowerBound),
  };
}

/** Replaces a Memory-derived panel's empty copy while browse has nothing to show. */
export function memoryPanelNotice(state: ReadState): string | null {
  if (state === "loading") return "Loading memories…";
  if (state === "error") return "Memories are currently unavailable.";
  return null;
}
