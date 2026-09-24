import type { ProxyMatcher } from "next/dist/build/analysis/get-page-static-info.js";

declare module "next/dist/build/analysis/get-page-static-info.js" {
  // Next's build uses this export at runtime but omits it from its declarations.
  export function getMiddlewareMatchers(
    matcher: readonly string[],
    nextConfig: Record<string, never>,
  ): ProxyMatcher[];
}
