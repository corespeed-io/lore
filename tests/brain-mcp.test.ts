import { expect, test } from "vitest";
import { READ_ONLY_TOOLS } from "../src/lib/gbrain.js";
import type { Db } from "../src/server/db.js";
import { READ_TOOL_NAMES, TOOLS, clampArgs, handleRpc } from "../src/server/mcp.js";
import type { Store } from "../src/server/store.js";

// A stub store: every read tool the registry exposes is exercised through
// handleRpc against this, so the envelope contract is tested without a DB.
const stub = {
  putPage: async () => ({ slug: "s", unchanged: false }),
  remember: async () => ({ slug: "mem-x" }),
  deletePage: async () => ({ slug: "s", deleted: true as const }),
  getPage: async ({ slug }: { slug: string }) => {
    if (slug === "missing") throw new Error(`not_found: ${slug}`);
    return { slug, title: "T", body: "B", updated_at: "2026-01-01T00:00:00.000Z" };
  },
  listPages: async () => [],
  search: async () => [{ slug: "a", title: "A", updated_at: "2026-01-01T00:00:00.000Z" }],
  getBacklinks: async () => [],
  traverseGraph: async () => [{ from_slug: "a", to_slug: "b" }],
  recentPages: async () => [],
  pageCount: async () => 3,
} as unknown as Store;

// Tools now receive { store, db }; the page tools never touch db, so a stub that
// throws proves they don't.
const stubDb = {
  query: async () => {
    throw new Error("page tools must not touch the database directly");
  },
  tx: async () => {
    throw new Error("page tools must not open a transaction");
  },
} as unknown as Db;
const getCtx = () => Promise.resolve({ store: stub, db: stubDb });

test("every read tool lore may call is in its READ_ONLY_TOOLS allowlist", () => {
  for (const name of READ_TOOL_NAMES) expect(READ_ONLY_TOOLS.has(name)).toBe(true);
});

test("write tools are not marked read", () => {
  for (const name of ["put_page", "remember", "delete_page", "forget", "rename_page"]) {
    expect(TOOLS[name].access).toBe("write");
  }
});

test("the memory tools are registered alongside the page tools", () => {
  for (const name of ["remember", "recall", "forget", "inspect_memory"]) {
    expect(TOOLS[name], `${name} is missing`).toBeTruthy();
  }
  // recall and inspect are reads, so a read-only bearer can use them
  expect(TOOLS.recall.access).toBe("read");
  expect(TOOLS.inspect_memory.access).toBe("read");
});

test("initialize answers without touching the store", async () => {
  const rpc = await handleRpc(
    () => Promise.reject(new Error("context must not be constructed")),
    "read",
    "initialize",
    { protocolVersion: "2025-03-26" },
  );
  const result = rpc.result as { protocolVersion: string; serverInfo: { name: string } };
  expect(result.protocolVersion).toBe("2025-03-26");
  expect(result.serverInfo.name).toBe("lore-brain");
});

test("tools/list filters write tools for read grants", async () => {
  const read = await handleRpc(getCtx, "read", "tools/list", {});
  const write = await handleRpc(getCtx, "write", "tools/list", {});
  const names = (r: typeof read) =>
    (r.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  expect(names(read)).not.toContain("put_page");
  expect(names(write)).toContain("put_page");
  expect(names(read)).toContain("search");
});

test("tools/call wraps results as a JSON string in content[0].text", async () => {
  const rpc = await handleRpc(getCtx, "read", "tools/call", {
    name: "search",
    arguments: { query: "x" },
  });
  const result = rpc.result as { content: { type: string; text: string }[]; isError: boolean };
  expect(result.isError).toBe(false);
  expect(typeof result.content[0].text).toBe("string");
  const parsed = JSON.parse(result.content[0].text);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed[0].slug).toBe("a");
});

test("missing page surfaces isError:true with a /not_found/ text (lore's regex)", async () => {
  const rpc = await handleRpc(getCtx, "read", "tools/call", {
    name: "get_page",
    arguments: { slug: "missing" },
  });
  const result = rpc.result as { content: { text: string }[]; isError: boolean };
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/not_found/);
});

test("traverse_graph rows carry from_slug/to_slug (lore's edge contract)", async () => {
  const rpc = await handleRpc(getCtx, "read", "tools/call", {
    name: "traverse_graph",
    arguments: { slug: "a" },
  });
  const rows = JSON.parse((rpc.result as { content: { text: string }[] }).content[0].text);
  expect(rows[0]).toEqual({ from_slug: "a", to_slug: "b" });
});

test("write tools are refused for read grants, allowed for write", async () => {
  // put_page rather than remember: this asserts the ACCESS gate, and remember now
  // legitimately needs the database (it writes a provenance event), which the
  // stub context refuses on purpose.
  const args = { slug: "s", body: "b" };
  const denied = await handleRpc(getCtx, "read", "tools/call", {
    name: "put_page",
    arguments: args,
  });
  expect(denied.error?.message).toMatch(/requires write access/);
  const ok = await handleRpc(getCtx, "write", "tools/call", { name: "put_page", arguments: args });
  expect((ok.result as { isError: boolean }).isError).toBe(false);
});

test("a user page cannot be written into the generated memory namespace", async () => {
  const res = await handleRpc(getCtx, "write", "tools/call", {
    name: "put_page",
    arguments: { slug: "memory/vault/whatever", body: "trying to squat" },
  });
  const result = res.result as { content: { text: string }[]; isError: boolean };
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/reserved/);
});

test("unknown tools and methods are JSON-RPC errors; notifications pass through", async () => {
  const unknown = await handleRpc(getCtx, "write", "tools/call", { name: "nope", arguments: {} });
  expect(unknown.error?.code).toBe(-32602);
  const method = await handleRpc(getCtx, "write", "bogus/method", {});
  expect(method.error?.code).toBe(-32601);
  const note = await handleRpc(getCtx, "read", "notifications/initialized", undefined);
  expect(note.notification).toBe(true);
});

test("clampArgs bounds the unbounded knobs at 200", () => {
  expect(clampArgs({ limit: 100000, depth: 50, query: "q" })).toEqual({
    limit: 200,
    depth: 50,
    query: "q",
  });
  expect(clampArgs(null)).toEqual({});
});
