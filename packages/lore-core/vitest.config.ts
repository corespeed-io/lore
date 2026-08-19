import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // PGlite's WASM Postgres cold start dominates; keep generous timeouts.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
