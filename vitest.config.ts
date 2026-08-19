import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      "@corespeed/lore-core/postgres": new URL(
        "./packages/lore-core/src/postgres.ts",
        import.meta.url,
      ).pathname,
      "@corespeed/lore-core/episodes": new URL(
        "./packages/lore-core/src/episodes/index.ts",
        import.meta.url,
      ).pathname,
      "@corespeed/lore-core/providers": new URL(
        "./packages/lore-core/src/providers.ts",
        import.meta.url,
      ).pathname,
      "@corespeed/lore-core": new URL("./packages/lore-core/src/index.ts", import.meta.url)
        .pathname,
      "@corespeed/lore-sdk": new URL("./packages/typescript-sdk/src/index.ts", import.meta.url)
        .pathname,
      "@corespeed/lore-cli": new URL("./packages/cli/src/index.ts", import.meta.url).pathname,
      "@corespeed/lore-mcp": new URL("./packages/mcp/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 30_000,
  },
});
