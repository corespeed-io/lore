import { expect, test } from "vitest";
import { checkAuth } from "../src/lib/auth.js";

const cookies = (m: Record<string, string> = {}) => ({
  get: (n: string) => (n in m ? { value: m[n] } : undefined),
});

test("none mode allows everything", () => {
  process.env.AUTH_MODE = "none";
  expect(checkAuth(new Headers(), cookies()).ok).toBe(true);
});

test("password mode rejects without basic auth", () => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  const r = checkAuth(new Headers(), cookies());
  expect(r.ok).toBe(false);
  expect(r.status).toBe(401);
  expect(r.wwwAuthenticate).toBe(true);
});

test("password mode accepts the right password (any username)", () => {
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  const h = new Headers({ authorization: `Basic ${Buffer.from("x:secret").toString("base64")}` });
  expect(checkAuth(h, cookies()).ok).toBe(true);
});

test("proxy mode requires the Cf-Access-Jwt-Assertion header", () => {
  process.env.AUTH_MODE = "proxy";
  process.env.ACCESS_AUD = "aud";
  process.env.ACCESS_TEAM_DOMAIN = "t";
  expect(checkAuth(new Headers(), cookies()).ok).toBe(false);
  expect(checkAuth(new Headers({ "cf-access-jwt-assertion": "tok" }), cookies()).ok).toBe(true);
});
