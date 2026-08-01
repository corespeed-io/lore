import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { expect, test } from "vitest";
import { READ_ONLY_TOOLS } from "../src/lib/gbrain.js";
import { type Db, type Query, initSchema } from "../src/server/db.js";
import type { ToolDef } from "../src/server/mcp.js";
import { READ_TOOL_NAMES, TOOLS, clampArgs, handleRpc, mergeTools } from "../src/server/mcp.js";
import { memoryHealth } from "../src/server/memory/consolidate.js";
import { projectionSlug, runProjections } from "../src/server/memory/projection.js";
import type { EmbedFn } from "../src/server/pipeline.js";
import { type Store, createStore } from "../src/server/store.js";

// A stub store: every read tool the registry exposes is exercised through
// handleRpc against this, so the envelope contract is tested without a DB.
const stub = {
  putPage: async () => ({ slug: "s", unchanged: false }),
  remember: async () => ({ slug: "mem-x" }),
  deletePage: async () => ({ slug: "s", deleted: true as const }),
  // Both write a marker rather than throwing: a namespace guard that stopped
  // working would reach the store and report success, which is the failure these
  // stubs exist to make visible.
  renamePage: async ({ slug, to }: { slug: string; to: string }) => ({ slug: to, from: slug }),
  restorePage: async ({ slug }: { slug: string }) => ({ slug, restored: true as const }),
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

// The reserved namespace was guarded on put_page only. rename_page could walk a
// projection OUT of it (nothing then retracts that page when the memory is
// forgotten) or a user page IN (a rebuild clobbers it), and restore_page could
// resurrect the page the projection lifecycle had just retired.
test("rename_page refuses both ends of the reserved memory/ namespace", async () => {
  const call = (args: Record<string, unknown>) =>
    handleRpc(getCtx, "write", "tools/call", { name: "rename_page", arguments: args });
  const out = (await call({ slug: "memory/vault/abc", to: "notes/kidnapped" })).result as {
    content: { text: string }[];
    isError: boolean;
  };
  expect(out.isError).toBe(true);
  expect(out.content[0].text).toMatch(/cannot be renamed/);

  const into = (await call({ slug: "notes/mine", to: "memory/vault/abc" })).result as {
    content: { text: string }[];
    isError: boolean;
  };
  expect(into.isError).toBe(true);
  expect(into.content[0].text).toMatch(/reserved/);

  // A rename that touches neither end still works.
  const ok = (await call({ slug: "notes/a", to: "notes/b" })).result as { isError: boolean };
  expect(ok.isError).toBe(false);
});

test("restore_page refuses a generated memory projection", async () => {
  const res = await handleRpc(getCtx, "write", "tools/call", {
    name: "restore_page",
    arguments: { slug: "memory/thread/t1/abc" },
  });
  const result = res.result as { content: { text: string }[]; isError: boolean };
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/maintenance pass/);
});

// Object.assign used to overwrite a same-named page tool with no signal at all —
// that is how the page-level remember vanished behind the memory one.
test("merging the registries fails loudly on a duplicate tool name", () => {
  const one: ToolDef = {
    access: "read",
    description: "a",
    inputSchema: {},
    handler: async () => null,
  };
  expect(() => mergeTools({ dup: one }, { dup: one })).toThrow(/duplicate MCP tool name 'dup'/);
  // And the shipped registry keeps both tools: remember is durable memory,
  // remember_note is the page-level note.
  expect(TOOLS.remember_note.access).toBe("write");
  expect((TOOLS.remember.inputSchema as { required: string[] }).required).toEqual(["content"]);
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

// --- Against real SQL (PGlite = Postgres 17) ---------------------------------
//
// The namespace guard is only half of revocation. These two run the whole path —
// tool call, projection, retraction, maintenance — because the defect they pin is
// a page and a memory row disagreeing about which page a memory owns.

const DIM = 8;
const embed: EmbedFn = async (texts) =>
  texts.map((t) => {
    const v = new Array(DIM).fill(0.01);
    for (let i = 0; i < t.length; i++) v[i % DIM] += (t.charCodeAt(i) % 97) / 97;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });

function pgliteDb(lite: PGlite): Db {
  const q: Query = async (text, params) => ({
    rows: (await lite.query(text, params as unknown[])).rows as Record<string, unknown>[],
  });
  return {
    query: q,
    async tx(fn) {
      const out = await lite.transaction((t) =>
        fn(async (text, params) => ({
          rows: (await t.query(text, params as unknown[])).rows as Record<string, unknown>[],
        })),
      );
      return out as Awaited<ReturnType<typeof fn>>;
    },
  };
}

// A fresh database per test, created only by the tests that need one — the stub
// tests above must not pay for a Postgres.
async function withBrain(fn: (ctx: { db: Db; store: Store }) => Promise<void>): Promise<void> {
  const pg = new PGlite({ extensions: { vector, pg_trgm } });
  const db = pgliteDb(pg);
  try {
    await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });
    await fn({ db, store: createStore(db, embed) });
  } finally {
    await pg.close();
  }
}

function callTool(ctx: { db: Db; store: Store }) {
  return async (name: string, args: Record<string, unknown>) => {
    const rpc = await handleRpc(() => Promise.resolve(ctx), "write", "tools/call", {
      name,
      arguments: args,
    });
    const result = rpc.result as { content: { text: string }[]; isError: boolean };
    if (result.isError) throw new Error(`${name} failed: ${result.content[0].text}`);
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  };
}

// Everything a search would show the user, so an assertion is about the CONTENT
// being reachable rather than about a slug.
async function searchText(store: Store, query: string): Promise<string> {
  const hits = await store.search({ query });
  return hits.map((h) => `${h.slug} ${h.title} ${h.chunk_text ?? ""}`).join("\n");
}

test("a projection moved out of memory/ is still retracted when its memory is forgotten", async () => {
  await withBrain(async (ctx) => {
    const call = callTool(ctx);
    const saved = (await call("remember", {
      content: "Zanzibar espresso is the house roast.",
      scope: "vault",
    })) as { saved: boolean; memory_id: string; projection: string };
    expect(saved.saved).toBe(true);
    expect(saved.projection).toBe("ok");
    const slug = `memory/vault/${saved.memory_id}`;
    const page = await ctx.db.query(
      "SELECT p.slug FROM memory_items m JOIN pages p ON p.id = m.projection_page_id WHERE m.id = $1",
      [saved.memory_id],
    );
    expect(String(page.rows[0].slug)).toBe(slug);

    // rename_page refuses this now, so reach past the tool: a database written
    // before the guard existed already looks like this, and forget still has to
    // work on it. This is the case slug-addressed retraction silently skipped.
    await ctx.store.renamePage({ slug, to: "notes/kidnapped" });
    expect(await searchText(ctx.store, "Zanzibar espresso")).toContain("Zanzibar");

    // scope is passed as well as the id: forget revokes within a named scope.
    expect((await call("forget", { memory_id: saved.memory_id, scope: "vault" })).revoked).toBe(1);
    // Two passes: a leak that survives one sweep is what the reviewer reproduced.
    await runProjections(ctx.db, ctx.store, 50);
    await runProjections(ctx.db, ctx.store, 50);

    expect((await memoryHealth(ctx.db)).stale_active_projections).toBe(0);
    expect(await searchText(ctx.store, "Zanzibar espresso")).not.toContain("Zanzibar");
  });
});

test("delete_page on a committed projection is rebuilt by the next maintenance pass", async () => {
  await withBrain(async (ctx) => {
    const call = callTool(ctx);
    const saved = (await call("remember", {
      content: "Lisbon cortado is the afternoon pour.",
      scope: "vault",
    })) as { memory_id: string };
    const slug = `memory/vault/${saved.memory_id}`;

    // The page is a derived retrieval projection and Postgres is canonical, so the
    // delete is allowed to stand — but it must not make the memory permanently
    // unreachable, which is what matching none of runProjections' arms did.
    expect((await call("delete_page", { slug })).deleted).toBe(true);
    expect(await searchText(ctx.store, "Lisbon cortado")).not.toContain("cortado");

    const swept = await runProjections(ctx.db, ctx.store, 50);
    expect(swept.projected).toBe(1);
    expect(await searchText(ctx.store, "Lisbon cortado")).toContain("cortado");
    expect((await ctx.store.getPage({ slug })).slug).toBe(slug);
    const health = await memoryHealth(ctx.db);
    expect([health.failed_projections, health.stale_active_projections]).toEqual([0, 0]);
  });
});
