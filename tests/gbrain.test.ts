import { expect, test } from "vitest";
import { READ_ONLY_TOOLS, ToolNotAllowedError, callTool, parseMcp } from "../src/lib/gbrain.js";

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
