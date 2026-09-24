import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  admitRequest,
  authorizeRequest,
  checkAuth,
  isCrossSiteRequest,
  isOperationalProbePath,
} from "../../src/server/auth/auth.js";

afterEach(() => vi.unstubAllGlobals());

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

// Cloudflare Access: a locally generated signing key served from a stubbed team JWKS.
const ACCESS_TEAM = "lore-test.cloudflareaccess.com";
const ACCESS_AUD = "lore-access-audience";
const accessKeys = (async () => {
  const signing = await generateKeyPair("RS256");
  const foreign = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(signing.publicKey)), kid: "lore-test", alg: "RS256" };
  return { foreign, publicJwk, signing };
})();
const jwksRequests: string[] = [];

async function accessToken(
  claims: { aud?: string; iss?: string; sub?: string | null; email?: string },
  times: { exp?: number; nbf?: number } = {},
  foreignKey = false,
): Promise<string> {
  const keys = await accessKeys;
  const now = Math.floor(Date.now() / 1_000);
  const jwt = new SignJWT(claims.email ? { email: claims.email } : {})
    .setProtectedHeader({ alg: "RS256", kid: "lore-test" })
    .setIssuer(claims.iss ?? `https://${ACCESS_TEAM}`)
    .setAudience(claims.aud ?? ACCESS_AUD)
    .setIssuedAt(now - 60)
    .setExpirationTime(times.exp ?? now + 300);
  if (times.nbf !== undefined) jwt.setNotBefore(times.nbf);
  if (claims.sub !== null) jwt.setSubject(claims.sub ?? "access-subject");
  return jwt.sign(foreignKey ? keys.foreign.privateKey : keys.signing.privateKey);
}

async function useAccessProxy(): Promise<void> {
  const { publicJwk } = await accessKeys;
  process.env.AUTH_MODE = "proxy";
  process.env.ACCESS_AUD = ACCESS_AUD;
  process.env.ACCESS_TEAM_DOMAIN = ACCESS_TEAM;
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    jwksRequests.push(url);
    if (url !== `https://${ACCESS_TEAM}/cdn-cgi/access/certs`) {
      return new Response("unexpected JWKS request", { status: 404 });
    }
    return Response.json({ keys: [publicJwk] });
  });
}

test("proxy mode accepts a Cloudflare Access JWT signed by the team JWKS", async () => {
  await useAccessProxy();
  const header = await checkAuth(
    new Headers({
      "cf-access-jwt-assertion": await accessToken({ email: "operator@example.com" }),
    }),
  );
  const cookie = await checkAuth(
    new Headers({ cookie: `CF_Authorization=${await accessToken({ sub: "cookie-subject" })}` }),
  );

  expect(jwksRequests).toContain(`https://${ACCESS_TEAM}/cdn-cgi/access/certs`);
  expect(header).toEqual({
    ok: true,
    principal: {
      provider: `cloudflare-access:${ACCESS_TEAM}`,
      subject: "access-subject",
      displayName: "operator@example.com",
      email: "operator@example.com",
    },
  });
  expect(cookie).toMatchObject({
    ok: true,
    principal: { subject: "cookie-subject", displayName: "cookie-subject" },
  });
});

test.each([
  ["wrong audience", () => accessToken({ aud: "another-application" })],
  ["wrong issuer", () => accessToken({ iss: "https://attacker.cloudflareaccess.com" })],
  ["expired token", () => accessToken({}, { exp: Math.floor(Date.now() / 1_000) - 120 })],
  ["not-yet-valid token", () => accessToken({}, { nbf: Math.floor(Date.now() / 1_000) + 3_600 })],
  ["token signed by a key outside the team JWKS", () => accessToken({}, {}, true)],
])("proxy mode rejects a Cloudflare Access JWT with a %s", async (_case, token) => {
  await useAccessProxy();
  await expect(
    checkAuth(new Headers({ "cf-access-jwt-assertion": await token() })),
  ).resolves.toEqual({ ok: false, status: 403, detail: "Cloudflare Access token invalid" });
});

test("proxy mode rejects a validly signed Cloudflare Access JWT without a subject", async () => {
  await useAccessProxy();
  await expect(
    checkAuth(new Headers({ "cf-access-jwt-assertion": await accessToken({ sub: null }) })),
  ).resolves.toEqual({ ok: false, status: 403, detail: "Cloudflare Access subject missing" });
});

test("admission returns the verified principal so handlers need not verify it again", async () => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  process.env.LORE_LOCAL_SUBJECT = "admitted-operator";
  const admitted = await admitRequest(
    new Request("https://lore.test/api/v1/memories", {
      headers: { authorization: `Basic ${btoa("user:secret")}` },
    }),
  );
  expect(admitted).toEqual({
    principal: { provider: "local", subject: "admitted-operator", displayName: "Local User" },
  });
  const agent = await admitRequest(
    new Request("https://lore.test/api/v1/memories", {
      headers: { authorization: `Bearer lore_agent_${"a".repeat(64)}` },
    }),
  );
  expect(agent).toEqual({});
  const denied = await admitRequest(new Request("https://lore.test/api/v1/memories"));
  expect(denied.principal).toBeUndefined();
  expect(denied.denied?.status).toBe(401);
});

test.each([
  ["a cross-site Fetch Metadata request", { "sec-fetch-site": "cross-site" }],
  ["a foreign Origin", { origin: "https://attacker.example" }],
  [
    "a same-site but cross-origin Origin",
    { origin: "https://evil.lore.test", "sec-fetch-site": "same-site" },
  ],
  ["an opaque null Origin", { origin: "null" }],
])("unsafe requests from %s are rejected before authentication", async (_case, headers) => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  for (const path of ["/api/workspaces", "/api/v1/workspaces"]) {
    const request = new Request(`https://lore.test${path}`, {
      method: "POST",
      headers: { ...headers, authorization: `Basic ${btoa("user:secret")}` },
    });
    expect(isCrossSiteRequest(request)).toBe(true);
    const response = await authorizeRequest(request);
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      code: "access_denied",
      error: "Cross-site request rejected",
    });
  }
});

test("same-origin browsers, proxied origins, safe methods, and non-browser clients pass", () => {
  const unsafe = (url: string, headers: Record<string, string>) =>
    new Request(url, { method: "POST", headers });
  expect(isCrossSiteRequest(unsafe("https://lore.test/api/v1/workspaces", {}))).toBe(false);
  expect(
    isCrossSiteRequest(
      unsafe("https://lore.test/api/v1/workspaces", {
        origin: "https://lore.test",
        "sec-fetch-site": "same-origin",
      }),
    ),
  ).toBe(false);
  // Self-host behind a TLS proxy: Next sees its listen address, the browser the public host.
  expect(
    isCrossSiteRequest(
      unsafe("http://0.0.0.0:3000/api/v1/workspaces", {
        host: "lore.example.com",
        origin: "https://lore.example.com",
      }),
    ),
  ).toBe(false);
  expect(
    isCrossSiteRequest(
      unsafe("http://localhost:3000/api/v1/workspaces", {
        host: "localhost:3000",
        "x-forwarded-host": "lore.example.com",
        origin: "https://lore.example.com",
      }),
    ),
  ).toBe(false);
  // A proxy that rewrites Host hides the public origin; the browser's Fetch Metadata
  // still vouches for a same-origin request, but a bare mismatched Origin does not.
  const rewrittenHost = { host: "127.0.0.1:3000", origin: "https://lore.example.com" };
  expect(
    isCrossSiteRequest(
      unsafe("http://127.0.0.1:3000/api/v1/workspaces", {
        ...rewrittenHost,
        "sec-fetch-site": "same-origin",
      }),
    ),
  ).toBe(false);
  expect(isCrossSiteRequest(unsafe("http://127.0.0.1:3000/api/v1/workspaces", rewrittenHost))).toBe(
    true,
  );
  expect(
    isCrossSiteRequest(
      new Request("https://lore.test/api/v1/memories", {
        headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      }),
    ),
  ).toBe(false);
});
