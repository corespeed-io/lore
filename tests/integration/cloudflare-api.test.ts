import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fetchCloudflareApi } from "@/server/api/cloudflare";

// Exercise the Worker's real HTTP adapter, including Hono admission and errors.
// Bindings fail if touched: public metadata must not need PostgreSQL or Queues.
const bindings = {
  get HYPERDRIVE(): never {
    throw new Error("PostgreSQL binding unavailable");
  },
  get MEMORY_MAINTENANCE_QUEUE(): never {
    throw new Error("Queue binding must not be used");
  },
};
const context = { waitUntil: vi.fn() };

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("AUTH_MODE", "none");
  vi.stubEnv("ALLOW_INSECURE", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function expectSecurityHeaders(response: Response) {
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(response.headers.get("strict-transport-security")).toBe(
    "max-age=63072000; includeSubDomains; preload",
  );
}

test("direct Cloudflare API responses retain the production security policy", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const [path, method, status, cache] of [
    ["/livez", "GET", 200, "no-store"],
    ["/openapi.json", "GET", 200, "public, max-age=3600"],
    ["/api/v1/unknown", "GET", 404, "private, no-store"],
    ["/livez", "POST", 405, "private, no-store"],
    ["/api/v1/memories", "OPTIONS", 204, "private, no-store"],
    ["/api/v1/workspaces", "GET", 500, "private, no-store"],
  ] as const) {
    const response = await fetchCloudflareApi(
      new Request(`https://lore.example${path}`, { method }),
      bindings,
      context,
    );
    expect(response.status, `${method} ${path}`).toBe(status);
    expectSecurityHeaders(response);
    expect(response.headers.get("cache-control")).toBe(cache);
    if (status === 405 || status === 204) {
      expect(response.headers.get("allow")).toContain("GET");
    }
    if (status === 204) {
      expect(response.headers.get("content-type")).toBeNull();
      expect(await response.text()).toBe("");
    }
    if (status === 500) {
      expect(await response.json()).toEqual({
        code: "internal_error",
        error: "Internal server error",
      });
    }
  }
  expect(context.waitUntil).not.toHaveBeenCalled();
});

test("Cloudflare admission refusals retain security headers and authentication challenge", async () => {
  vi.stubEnv("AUTH_MODE", "password");
  vi.stubEnv("UI_PASSWORD", "test-password");
  for (const path of ["/api/v1/memories", "/openapi.json"]) {
    const response = await fetchCloudflareApi(
      new Request(`https://lore.example${path}`),
      bindings,
      context,
    );
    expect(response.status).toBe(401);
    expectSecurityHeaders(response);
    expect(response.headers.get("www-authenticate")).toBe("Basic");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
});
