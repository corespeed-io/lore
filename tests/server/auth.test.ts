import { beforeEach, expect, test } from "vitest";
import { authorizeRequest, checkAuth, isOperationalProbePath } from "../../src/server/auth/auth.js";

beforeEach(() => {
  for (const k of [
    "AUTH_MODE",
    "ALLOW_INSECURE",
    "UI_PASSWORD",
    "ACCESS_AUD",
    "ACCESS_TEAM_DOMAIN",
    "LORE_LOCAL_SUBJECT",
    "LORE_LOCAL_DISPLAY_NAME",
    "LORE_LOCAL_EMAIL",
  ]) {
    delete process.env[k];
  }
});

test("none mode fails closed without ALLOW_INSECURE", async () => {
  process.env.AUTH_MODE = "none";
  const r = await checkAuth(new Headers());
  expect(r.ok).toBe(false);
  expect(r.status).toBe(403);
});

test("none mode allows only with explicit ALLOW_INSECURE", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  expect(await checkAuth(new Headers())).toMatchObject({
    ok: true,
    principal: { provider: "local", subject: "local", displayName: "Local User" },
  });
});

test("none-mode 403 explains the real cause (AUTH_MODE / ALLOW_INSECURE)", async () => {
  process.env.AUTH_MODE = "none";
  const r = await checkAuth(new Headers());
  expect(r.ok).toBe(false);
  expect(r.detail).toMatch(/ALLOW_INSECURE/);
  expect(r.detail).not.toMatch(/Cloudflare/); // no more misleading "Cloudflare Access required"
});

test("password mode with no UI_PASSWORD fails closed and says so", async () => {
  process.env.AUTH_MODE = "password";
  const r = await checkAuth(new Headers());
  expect(r.ok).toBe(false);
  expect(r.status).toBe(403);
  expect(r.detail).toMatch(/UI_PASSWORD/);
});

test("password mode never falls back to insecure access when UI_PASSWORD is missing", async () => {
  process.env.AUTH_MODE = "password";
  process.env.ALLOW_INSECURE = "1";
  const r = await checkAuth(new Headers());
  expect(r.ok).toBe(false);
  expect(r.status).toBe(403);
  expect(r.detail).toMatch(/UI_PASSWORD/);
});

test("password mode rejects without basic auth", async () => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  const r = await checkAuth(new Headers());
  expect(r.ok).toBe(false);
  expect(r.status).toBe(401);
  expect(r.wwwAuthenticate).toBe(true);
});

test("password mode accepts the right password (any username)", async () => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  const h = new Headers({ authorization: `Basic ${btoa("x:secret")}` });
  expect(await checkAuth(h)).toMatchObject({
    ok: true,
    principal: { provider: "local", subject: "local", displayName: "Local User" },
  });
});

test("password mode does not let the Basic username select another User identity", async () => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  process.env.LORE_LOCAL_SUBJECT = "self-hosted-operator";
  process.env.LORE_LOCAL_DISPLAY_NAME = "Operator";

  const alice = await checkAuth(new Headers({ authorization: `Basic ${btoa("alice:secret")}` }));
  const bob = await checkAuth(new Headers({ authorization: `Basic ${btoa("bob:secret")}` }));

  expect(alice.principal).toEqual(bob.principal);
  expect(alice.principal).toMatchObject({
    provider: "local",
    subject: "self-hosted-operator",
    displayName: "Operator",
  });
});

test("invalid mode never downgrades to insecure access", async () => {
  process.env.AUTH_MODE = "gateway";
  process.env.ALLOW_INSECURE = "1";

  await expect(checkAuth(new Headers())).resolves.toMatchObject({
    ok: false,
    status: 403,
    detail: expect.stringMatching(/AUTH_MODE/),
  });
});

test("password mode rejects malformed Basic credentials without throwing", async () => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  const h = new Headers({ authorization: "Basic !!!not-base64!!!" });
  await expect(checkAuth(h)).resolves.toMatchObject({ ok: false, status: 401 });
});

test("proxy mode fails closed when Access vars are missing", async () => {
  process.env.AUTH_MODE = "proxy";
  const h = new Headers({ "cf-access-jwt-assertion": "tok" });
  expect((await checkAuth(h)).ok).toBe(false);
});

test("proxy mode rejects a forged / unverifiable token", async () => {
  process.env.AUTH_MODE = "proxy";
  process.env.ACCESS_AUD = "aud";
  process.env.ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com";
  // A bare string is not a valid JWS; jwtVerify throws before any network call,
  // so checkAuth fails closed — the old presence-only check would have allowed it.
  const h = new Headers({ "cf-access-jwt-assertion": "tok" });
  expect((await checkAuth(h)).ok).toBe(false);
});

test.each(["CF_Authorization=forged", "irrelevant=%; CF_Authorization=%ZZ"])(
  "proxy mode verifies Access cookies and rejects invalid tokens: %s",
  async (cookie) => {
    process.env.AUTH_MODE = "proxy";
    process.env.ACCESS_AUD = "aud";
    process.env.ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com";
    await expect(checkAuth(new Headers({ cookie }))).resolves.toMatchObject({
      ok: false,
      status: 403,
      detail: "Cloudflare Access token invalid",
    });
  },
);

test("an unrelated malformed cookie does not break password admission", async () => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  const request = new Request("https://lore.test/api/memories", {
    headers: { authorization: `Basic ${btoa("user:secret")}`, cookie: "irrelevant=%" },
  });
  await expect(authorizeRequest(request)).resolves.toBeUndefined();
});

test("operational probes bypass application authentication without widening API access", () => {
  expect(isOperationalProbePath("/livez")).toBe(true);
  expect(isOperationalProbePath("/readyz")).toBe(true);
  expect(isOperationalProbePath("/api/health")).toBe(true);

  expect(isOperationalProbePath("/api/v1/memories")).toBe(false);
  expect(isOperationalProbePath("/livez/extra")).toBe(false);
  expect(isOperationalProbePath("/readyz?full=1")).toBe(false);
});
