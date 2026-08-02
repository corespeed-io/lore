import { expect, test } from "vitest";
import { loadConfig } from "../src/lib/config.js";

test("defaults are applied when env is empty", () => {
  const c = loadConfig({});
  expect(c.appTitle).toBe("Lore");
  expect(c.appSubtitle).toMatch(/knowledge graph/);
  expect(c.authMode).toBe("none");
  expect(c.seedQueries.length).toBeGreaterThan(0);
});

test("SEED_QUERIES splits on '||' and trims", () => {
  const c = loadConfig({ SEED_QUERIES: " a b || c d " });
  expect(c.seedQueries).toEqual(["a b", "c d"]);
});

test("invalid AUTH_MODE falls back to none", () => {
  expect(loadConfig({ AUTH_MODE: "bogus" }).authMode).toBe("none");
});

test("gateway settings pass through, with usable defaults", () => {
  const c = loadConfig({
    AUTH_GATEWAY_SHARED_SECRET: "s",
    AUTH_GATEWAY_JWKS_URL: "https://gw/certs",
  });
  expect(c.gateway.sharedSecret).toBe("s");
  expect(c.gateway.jwksUrl).toBe("https://gw/certs");
  // Defaults chosen so a Cloudflare Access deployment needs only ISSUER/AUDIENCE.
  expect(c.gateway.jwtHeader).toBe("Cf-Access-Jwt-Assertion");
  expect(c.gateway.userHeader).toBe("X-Forwarded-User");
  expect(c.gateway.secretHeader).toBe("X-Auth-Gateway-Secret");
});

test("gateway is a real auth mode; unknown modes still fall back to none", () => {
  expect(loadConfig({ AUTH_MODE: "gateway" }).authMode).toBe("gateway");
  expect(loadConfig({ AUTH_MODE: "proxy" }).authMode).toBe("none");
});
