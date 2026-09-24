/** Bump whenever parser, symbol, chunking, or dependency-edge derivation changes. */
export const CODE_INDEX_REVISION = "ast-grep-0.45.3-web-structural-graph-v7-exact-root-partition";

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
