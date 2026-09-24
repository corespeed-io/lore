import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// fileURLToPath decodes the URL; URL.pathname would keep spaces and non-ASCII
// characters percent-encoded and break every alias under such a checkout path.
function repositoryPath(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@": repositoryPath("./src"),
      "@corespeed/lore-core/postgres": repositoryPath("./packages/lore-core/src/postgres.ts"),
      "@corespeed/lore-core/episodes": repositoryPath("./packages/lore-core/src/episodes/index.ts"),
      "@corespeed/lore-core": repositoryPath("./packages/lore-core/src/index.ts"),
      "@corespeed/lore-sdk": repositoryPath("./packages/typescript-sdk/src/index.ts"),
      "@corespeed/lore-cli": repositoryPath("./packages/cli/src/index.ts"),
      "@corespeed/lore-mcp": repositoryPath("./packages/mcp/src/index.ts"),
    },
  },
  test: {
    // Bun already provides CJS/ESM interop; Vitest's Node interop drops Zod exports.
    deps: { interopDefault: false },
    experimental: { fsModuleCache: true },
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
