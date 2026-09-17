import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bun already provides CJS/ESM interop without Vitest's Node conversion.
    deps: { interopDefault: false },
    experimental: { fsModuleCache: true },
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // PGlite's WASM Postgres cold start dominates; keep generous timeouts.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
