import {
  getMiddlewareMatchers,
  type ProxyMatcher,
} from "next/dist/build/analysis/get-page-static-info.js";
import { expect, test } from "vitest";
import { config } from "@/middleware";

declare module "next/dist/build/analysis/get-page-static-info.js" {
  // Next's build uses this export at runtime but omits it from its declarations.
  export function getMiddlewareMatchers(
    matcher: readonly string[],
    nextConfig: Record<string, never>,
  ): ProxyMatcher[];
}

// Compile the checked-in matcher exactly as Next does, so the test measures Next's
// path-to-regexp semantics rather than a hand-copied regular expression.
function middlewareRuns(path: string): boolean {
  return getMiddlewareMatchers(config.matcher, {}).some((matcher) =>
    new RegExp(matcher.regexp).test(path),
  );
}

test("middleware never receives API bodies, so large Workspace imports are not truncated", () => {
  for (const path of [
    "/api",
    "/api/",
    "/api/workspaces",
    "/api/v1/workspaces/import",
    "/api/v1/memories/00000000-0000-4000-8000-000000000001",
    "/api/prototype",
  ]) {
    expect(middlewareRuns(path), path).toBe(false);
  }
});

test("middleware still admits pages and the development Graph benchmark", () => {
  for (const path of [
    "/",
    "/memories",
    "/memories/00000000-0000-4000-8000-000000000001",
    "/graph",
    "/prototype/graph-scale",
    "/api/prototype/graph-scale",
    "/apiary",
  ]) {
    expect(middlewareRuns(path), path).toBe(true);
  }
  for (const path of ["/_next/static/chunks/app.js", "/_next/image", "/favicon.ico"]) {
    expect(middlewareRuns(path), path).toBe(false);
  }
});
