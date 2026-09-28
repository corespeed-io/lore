import type { MemoryGraphContext } from "@/modules/memories/browser/presentation";
import { displayCount, type ReadState, UNKNOWN_COUNT } from "@/shared/browser/read-state";
import { GRAPH_NODE_LIMIT } from "./types";

const GRAPH_WINDOW = `the Graph's ${displayCount(GRAPH_NODE_LIMIT, "ready")}-Memory read window`;

/**
 * What Memory detail may claim from the Workspace Graph. Wikilinks, Related, and
 * Connections all resolve against that one read, so before it loads, after it
 * fails, or for a Memory outside its capped window, none of them may claim zero
 * or "not found".
 */
export function memoryGraphContext(input: {
  state: ReadState;
  /** The read may have omitted visible Memories. */
  capped: boolean;
  /** The read cut durable Links, so neighbors are a lower bound and affinity is off. */
  linksTruncated?: boolean;
  inGraph: boolean;
  relatedCount: number;
}): MemoryGraphContext {
  if (input.state === "loading") {
    return {
      connections: UNKNOWN_COUNT,
      relatedNotice: "Loading related Memories…",
      unresolvedWikilinkTitle: "Resolving Memory reference…",
    };
  }
  if (input.state === "error") {
    return {
      connections: UNKNOWN_COUNT,
      relatedNotice: "Related Memories are currently unavailable.",
      unresolvedWikilinkTitle: "Memory references are unavailable until the Graph loads",
    };
  }
  const unresolvedWikilinkTitle = input.capped
    ? `Memory reference is not in ${GRAPH_WINDOW}`
    : "Memory reference not found";
  if (!input.inGraph) {
    return {
      connections: UNKNOWN_COUNT,
      relatedNotice: input.capped
        ? `This Memory is outside ${GRAPH_WINDOW}.`
        : "This Memory is not in the loaded Graph yet.",
      unresolvedWikilinkTitle,
    };
  }
  const linksPartial = input.capped || input.linksTruncated === true;
  return {
    connections: displayCount(input.relatedCount, "ready", linksPartial),
    relatedNotice:
      input.relatedCount !== 0
        ? null
        : input.linksTruncated
          ? "The Graph reached its Link budget, so its Links are incomplete and it derives no affinities."
          : input.capped
            ? `No affinities inside ${GRAPH_WINDOW}.`
            : null,
    unresolvedWikilinkTitle,
  };
}
