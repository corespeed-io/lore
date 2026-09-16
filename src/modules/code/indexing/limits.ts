export const CODE_INDEX_LIMITS = {
  maximumArtifactCodeUnits: 6_000,
  maximumArtifacts: 100_000,
  maximumFileBytes: 2 * 1024 * 1024,
  maximumFiles: 20_000,
  maximumSourceBytes: 128 * 1024 * 1024,
  parserConcurrency: 4,
} as const;
