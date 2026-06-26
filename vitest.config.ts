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
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
