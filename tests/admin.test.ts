import { expect, test } from "vitest";
import {
  ADMIN_CHART_TYPES,
  ADMIN_ENDPOINTS,
  adminEnabled,
  adminPostRejection,
  redactAdminResponse,
  stripSecrets,
} from "../src/lib/admin.js";
import { READ_ONLY_TOOLS } from "../src/lib/gbrain.js";

const base = {
  ADMIN_MODE: "1",
  ADMIN_GBRAIN_URL: "https://brain.example",
  ADMIN_GBRAIN_TOKEN: "boot",
};

test("admin allowlist is explicit and separate from the viewer read allowlist", () => {
  const keys = Object.keys(ADMIN_ENDPOINTS);
  expect(keys.length).toBeGreaterThan(0);
  // No admin action leaks into the read-only viewer allowlist.
  for (const k of keys) expect(READ_ONLY_TOOLS.has(k)).toBe(false);
  // Mutating actions are POST + flagged so the UI gates/confirms them.
  expect(ADMIN_ENDPOINTS["revoke-client"]).toMatchObject({ method: "POST", destructive: true });
  expect(ADMIN_ENDPOINTS["create-api-key"]).toMatchObject({ method: "POST", oneTimeSecret: true });
});

test("admin is fail-closed by default", () => {
  expect(adminEnabled({}).ok).toBe(false);
  expect(adminEnabled({ ADMIN_MODE: "1" }).ok).toBe(false); // no url/token
  expect(adminEnabled({ ADMIN_MODE: "1", ADMIN_GBRAIN_URL: "https://x" }).ok).toBe(false); // no token
});

test("admin enables only with full env config", () => {
  expect(adminEnabled({ ...base, AUTH_MODE: "password" }).ok).toBe(true);
});

test("AUTH_MODE=none requires an explicit admin insecure opt-in", () => {
  expect(adminEnabled({ ...base, AUTH_MODE: "none" }).ok).toBe(false);
  expect(adminEnabled({ ...base, AUTH_MODE: "none", ADMIN_ALLOW_INSECURE: "1" }).ok).toBe(true);
});

test("stripSecrets redacts secret-ish fields recursively and never returns them", () => {
  const out = stripSecrets({
    name: "ci",
    token: "gbrain_at_abc",
    nested: { client_secret: "shh", scopes: ["read"] },
    list: [{ api_key: "k", ok: true }],
    // biome-ignore lint/suspicious/noExplicitAny: test reads dynamic shape
  }) as any;
  expect(out.name).toBe("ci");
  expect(out.token).toBe("[redacted]");
  expect(out.nested.client_secret).toBe("[redacted]");
  expect(out.nested.scopes).toEqual(["read"]);
  expect(out.list[0].api_key).toBe("[redacted]");
  expect(out.list[0].ok).toBe(true);
  const json = JSON.stringify(out);
  expect(json).not.toContain("gbrain_at_abc");
  expect(json).not.toContain("shh");
});

test("stripSecrets keeps benign token_ttl / token_type / grant_types", () => {
  const out = stripSecrets({
    active_api_keys: 7,
    token_ttl: 3600,
    token_type: "bearer",
    grant_types: ["client_credentials"],
    client_secret: "x",
    access_token: "y",
    // biome-ignore lint/suspicious/noExplicitAny: dynamic test shape
  }) as any;
  expect(out.active_api_keys).toBe(7);
  expect(out.token_ttl).toBe(3600);
  expect(out.token_type).toBe("bearer");
  expect(out.grant_types).toEqual(["client_credentials"]);
  expect(out.client_secret).toBe("[redacted]");
  expect(out.access_token).toBe("[redacted]");
});

test("create-api-key surfaces ONLY the one-time token, redacting any other secret", () => {
  const out = redactAdminResponse(
    {
      id: "k1",
      name: "ci",
      token: "gbrain_sk_live_xyz", // the one-time secret the UI must show once
      client_secret: "leak",
      refresh_token: "leak2",
    },
    true,
    // biome-ignore lint/suspicious/noExplicitAny: test reads dynamic shape
  ) as any;
  expect(out.token).toBe("gbrain_sk_live_xyz"); // survives
  expect(out.client_secret).toBe("[redacted]"); // everything else stripped
  expect(out.refresh_token).toBe("[redacted]");
  expect(out.id).toBe("k1");
  expect(out.name).toBe("ci");
});

test("redactAdminResponse strips the token too when not a one-time-secret action", () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic test shape
  const out = redactAdminResponse({ token: "secret" }, false) as any;
  expect(out.token).toBe("[redacted]");
});

test("admin POST CSRF guard: requires JSON content-type AND same-origin", () => {
  const lore = "lore.example";
  // legit same-origin JSON request → allowed
  expect(
    adminPostRejection({
      contentType: "application/json",
      origin: "https://lore.example",
      host: lore,
    }),
  ).toBeNull();
  // HTML-form CSRF (urlencoded, no Origin a form can forge) → 415
  expect(
    adminPostRejection({
      contentType: "application/x-www-form-urlencoded",
      origin: null,
      host: lore,
    })?.status,
  ).toBe(415);
  // cross-site JSON → 403
  expect(
    adminPostRejection({
      contentType: "application/json",
      origin: "https://evil.example",
      host: lore,
    })?.status,
  ).toBe(403);
  // JSON but no Origin header → 403 (browsers send Origin on POST)
  expect(
    adminPostRejection({ contentType: "application/json", origin: null, host: lore })?.status,
  ).toBe(403);
});

test("chart-type allowlist is explicit — no arbitrary SVG passthrough", () => {
  expect([...ADMIN_CHART_TYPES].sort()).toEqual([
    "abandoned-threads",
    "brier-trend",
    "domain-bars",
    "pattern-statements",
  ]);
  expect(ADMIN_CHART_TYPES.has("arbitrary")).toBe(false);
  expect(ADMIN_CHART_TYPES.has("../../etc/passwd")).toBe(false);
});

test("admin allowlist covers the upstream admin API surface", () => {
  for (const k of [
    "stats",
    "health",
    "agents",
    "requests",
    "jobs",
    "calibration",
    "api-keys",
    "create-api-key",
    "revoke-api-key",
    "revoke-client",
    "update-client-ttl",
    "sign-out-everywhere",
  ])
    expect(ADMIN_ENDPOINTS[k]).toBeDefined();
});
