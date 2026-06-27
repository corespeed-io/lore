import { expect, test } from "vitest";
import { ADMIN_ENDPOINTS, adminEnabled, stripSecrets } from "../src/lib/admin.js";
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
