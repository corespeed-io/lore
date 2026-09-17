import { fileURLToPath } from "node:url";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";
import { securityHeaders } from "./src/server/security-headers";

export default {
  output: "standalone",
  // The engine and SDK packages are consumed as TypeScript source inside this repo;
  // publishing builds happen in the package itself.
  transpilePackages: ["@corespeed/lore-core", "@corespeed/lore-sdk"],
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  // Next traces pg-cloudflare's Node fallback by default. OpenNext bundles under
  // the `workerd` condition, so include the actual Worker socket implementation.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/pg-cloudflare/dist/**/*", "./node_modules/pg-cloudflare/esm/**/*"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
} satisfies NextConfig;

if (
  process.env.NODE_ENV === "development" &&
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
) {
  initOpenNextCloudflareForDev();
}
