import { expect, test } from "vitest";
import { loadConfig } from "../src/lib/config.js";
import {
  READ_ONLY_TOOLS,
  ToolNotAllowedError,
  buildTokenRequest,
  callTool,
  parseMcp,
  resolveCredential,
} from "../src/lib/gbrain.js";

const baseEnv = {
  GBRAIN_MCP_URL: "https://brain.example/mcp",
  GBRAIN_CLIENT_ID: "cid",
  GBRAIN_CLIENT_SECRET: "csec",
};

const WRITE_TOOLS = [
  "put_page",
  "delete_page",
  "add_link",
  "forget_fact",
  "submit_job",
  "get_stats",
];

test("allowlist excludes every write/admin tool", () => {
  for (const t of WRITE_TOOLS) expect(READ_ONLY_TOOLS.has(t)).toBe(false);
});

test("allowlist includes the read tools the UI needs", () => {
  for (const t of [
    "list_pages",
    "get_page",
    "search",
    "query",
    "get_backlinks",
    "sources_list",
    "get_recent_salience",
  ])
    expect(READ_ONLY_TOOLS.has(t)).toBe(true);
});

test("parseMcp reads the SSE data line", () => {
  const body = 'event: message\ndata: {"result":{"content":[{"text":"hi"}]}}\n\n';
  // biome-ignore lint/suspicious/noExplicitAny: dynamic SSE response
  expect((parseMcp(body) as any).result.content[0].text).toBe("hi");
});

test("callTool rejects a non-allowlisted tool before any network call", async () => {
  await expect(callTool("put_page", { slug: "x" })).rejects.toBeInstanceOf(ToolNotAllowedError);
});

test("buildTokenRequest (post) puts creds in the body, derives the token URL", () => {
  const req = buildTokenRequest(loadConfig(baseEnv));
  expect(req.url).toBe("https://brain.example/token");
  expect(req.headers.Authorization).toBeUndefined();
  const p = new URLSearchParams(req.body);
  expect(p.get("grant_type")).toBe("client_credentials");
  expect(p.get("client_id")).toBe("cid");
  expect(p.get("client_secret")).toBe("csec");
});

test("buildTokenRequest (basic) uses the Authorization header, not the body", () => {
  const req = buildTokenRequest(loadConfig({ ...baseEnv, GBRAIN_TOKEN_AUTH_METHOD: "basic" }));
  expect(req.headers.Authorization).toBe(`Basic ${btoa("cid:csec")}`);
  const p = new URLSearchParams(req.body);
  expect(p.get("client_secret")).toBeNull();
  expect(p.get("grant_type")).toBe("client_credentials");
});

test("buildTokenRequest includes scope and honors GBRAIN_TOKEN_URL", () => {
  const req = buildTokenRequest(
    loadConfig({ ...baseEnv, GBRAIN_SCOPE: "read", GBRAIN_TOKEN_URL: "https://x/oauth/token" }),
  );
  expect(req.url).toBe("https://x/oauth/token");
  expect(new URLSearchParams(req.body).get("scope")).toBe("read");
});

test("resolveCredential: a full OAuth client mints (oauth)", () => {
  expect(resolveCredential(loadConfig(baseEnv)).kind).toBe("oauth");
});

test("resolveCredential: GBRAIN_TOKEN alone uses the static bearer", () => {
  expect(resolveCredential(loadConfig({ GBRAIN_TOKEN: "t" }))).toEqual({
    kind: "static",
    token: "t",
  });
});

test("resolveCredential: a half-configured OAuth client throws, never falls back silently", () => {
  expect(() => resolveCredential(loadConfig({ GBRAIN_CLIENT_ID: "cid" }))).toThrow(
    /half-configured/,
  );
  expect(() => resolveCredential(loadConfig({ GBRAIN_CLIENT_SECRET: "csec" }))).toThrow(
    /half-configured/,
  );
});

test("resolveCredential: no credentials at all throws instead of an empty Bearer", () => {
  expect(() => resolveCredential(loadConfig({}))).toThrow(/credentials missing/);
});

test("callTool fails clearly when GBRAIN_MCP_URL is unset", async () => {
  process.env.GBRAIN_MCP_URL = ""; // empty (falsy) without the `delete` operator biome flags
  await expect(callTool("search", {})).rejects.toThrow(/GBRAIN_MCP_URL/);
});
