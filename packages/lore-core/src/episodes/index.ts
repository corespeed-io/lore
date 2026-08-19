/**
 * Optional Episode/Observation capability group: bounded, ordered, immutable
 * evidence envelopes plus their separate rebuildable hybrid retrieval index.
 * Hosts that provision the episode tables opt in by importing this entry;
 * the kernel never depends on it.
 */

export * from "./episode-evidence";
export * from "./observations";
