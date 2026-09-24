/** Bump whenever parser, symbol, chunking, or dependency-edge derivation changes. */
export const CODE_INDEX_REVISION = "ast-grep-0.45.3-web-structural-graph-v7-exact-root-partition";

/**
 * Every earlier CODE_INDEX_REVISION. The maintenance sweep cancels unfinished jobs of
 * exactly these, never of a revision it does not know, so a worker of this release
 * still sweeping during a later rollout leaves the newer revision's jobs alone.
 * Append the previous value here whenever CODE_INDEX_REVISION is bumped.
 */
export const SUPERSEDED_CODE_INDEX_REVISIONS: readonly string[] = [
  "ast-grep-0.45.1-web-structural-graph-v6-derived-sets",
  "ast-grep-0.45.3-web-structural-graph-v6-derived-sets",
];

export const CODE_INDEX_LIMITS = {
  maximumArtifactCodeUnits: 6_000,
  maximumArtifacts: 100_000,
  maximumFileBytes: 2 * 1024 * 1024,
  maximumFiles: 20_000,
  maximumSourceBytes: 128 * 1024 * 1024,
  parserConcurrency: 4,
  /**
   * Artifact budget of one leased checkpoint transaction. Complete files are grouped up to
   * this many Artifacts; a single larger file still commits alone and whole.
   */
  checkpointArtifacts: 500,
} as const;
