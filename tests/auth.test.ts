import { beforeEach, expect, test } from "vitest";
import { checkAuth } from "../src/lib/auth.js";

const cookies = (m: Record<string, string> = {}) => ({
  get: (n: string) => (n in m ? { value: m[n] } : undefined),
});

beforeEach(() => {
  for (const k of [
    "AUTH_MODE",
    "ALLOW_INSECURE",
    "UI_PASSWORD",
    "ACCESS_AUD",
    "ACCESS_TEAM_DOMAIN",
  ]) {
    delete process.env[k];
  }
});

test("none mode fails closed without ALLOW_INSECURE", async () => {
  process.env.AUTH_MODE = "none";
  const r = await checkAuth(new Headers(), cookies());
  expect(r.ok).toBe(false);
  expect(r.status).toBe(403);
});

test("none mode allows only with explicit ALLOW_INSECURE", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  expect((await checkAuth(new Headers(), cookies())).ok).toBe(true);
});

test("password mode rejects without basic auth", async () => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  const r = await checkAuth(new Headers(), cookies());
  expect(r.ok).toBe(false);
  expect(r.status).toBe(401);
  expect(r.wwwAuthenticate).toBe(true);
});

test("password mode accepts the right password (any username)", async () => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  const h = new Headers({ authorization: `Basic ${btoa("x:secret")}` });
  expect((await checkAuth(h, cookies())).ok).toBe(true);
});

test("proxy mode fails closed when Access vars are missing", async () => {
  process.env.AUTH_MODE = "proxy";
  const h = new Headers({ "cf-access-jwt-assertion": "tok" });
  expect((await checkAuth(h, cookies())).ok).toBe(false);
});

test("proxy mode rejects a forged / unverifiable token", async () => {
  process.env.AUTH_MODE = "proxy";
  process.env.ACCESS_AUD = "aud";
  process.env.ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com";
  // A bare string is not a valid JWS; jwtVerify throws before any network call,
  // so checkAuth fails closed — the old presence-only check would have allowed it.
  const h = new Headers({ "cf-access-jwt-assertion": "tok" });
  expect((await checkAuth(h, cookies())).ok).toBe(false);
});
