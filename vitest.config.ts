import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      // `server-only` throws outside an RSC context; in the node test env resolve
      // it to its own no-op stub (the same file its react-server export points to).
      "server-only": new URL("./node_modules/server-only/empty.js", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Most suites here boot a real Postgres 17 in WASM (PGlite), which costs
    // seconds per instance — and vitest runs files in parallel, so they contend.
    // The 5s default was already marginal (a migration test measured 5.5s under
    // load and failed as a "timeout" while passing in isolation); this is wall
    // clock for a genuinely slow fixture, not cover for a hanging test.
    testTimeout: 30_000,
  },
});
