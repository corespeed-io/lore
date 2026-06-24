import { expect, test } from "vitest";
import { loadConfig } from "../src/lib/config.js";

test("defaults are applied when env is empty", () => {
  const c = loadConfig({});
  expect(c.appTitle).toBe("gbrain");
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

test("token and url pass through", () => {
  const c = loadConfig({ GBRAIN_TOKEN: "t", GBRAIN_MCP_URL: "http://x/mcp" });
  expect(c.gbrainToken).toBe("t");
  expect(c.gbrainMcpUrl).toBe("http://x/mcp");
});
