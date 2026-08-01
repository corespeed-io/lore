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

// Every spelling of a reserved slug that a trim() removes. The guards these
// replaced read String(a.slug) while the store persisted args.slug.trim(), so
// anything trim() drops was invisible to the door and gone by the time the row was
// written: ONE leading space squatted memory/vault/<id>, walked a projection out of
// the namespace, and resurrected a retracted one. The stub store REPORTS SUCCESS
// for all four calls, so this fails the moment the door stops deciding on the same
// normalized string the store does.
const WHITESPACE = [" ", "\t", "\n", "\r\n", "\u00a0"];

test("no whitespace spelling of a memory/ slug gets past the tool door", async () => {
  const call = async (name: string, args: Record<string, unknown>) => {
    const rpc = await handleRpc(getCtx, "write", "tools/call", { name, arguments: args });
    return rpc.result as { content: { text: string }[]; isError: boolean };
  };
  for (const ws of WHITESPACE) {
    const at = JSON.stringify(ws);
    for (const slug of [`${ws}memory/vault/squat`, `memory/vault/squat${ws}`]) {
      const put = await call("put_page", { slug, body: "trying to squat" });
      expect(put.isError, `put_page ${at}`).toBe(true);
      expect(put.content[0].text, `put_page ${at}`).toMatch(/reserved/);

      const out = await call("rename_page", { slug, to: "notes/kidnapped" });
      expect(out.isError, `rename out of memory/ ${at}`).toBe(true);
      expect(out.content[0].text, `rename out ${at}`).toMatch(/cannot be renamed/);

      const into = await call("rename_page", { slug: "notes/mine", to: slug });
      expect(into.isError, `rename into memory/ ${at}`).toBe(true);
      expect(into.content[0].text, `rename in ${at}`).toMatch(/reserved/);

      const revived = await call("restore_page", { slug });
      expect(revived.isError, `restore_page ${at}`).toBe(true);
      expect(revived.content[0].text, `restore_page ${at}`).toMatch(/maintenance pass/);
    }
  }
  // The same bypass by coercion: String([" memory/vault/x"]) is an untrimmed slug
  // again, and a per-handler String(a.slug) fed exactly that to both the guard and
  // the store. Read the way the store reads it, a non-string names NOTHING — so
  // there is no second spelling left for a check to miss.
  const coerced = await call("rename_page", { slug: [" memory/vault/squat"], to: "notes/free" });
  expect(JSON.parse(coerced.content[0].text).from).toBe("");
});

test("a reserved slug is refused before the store is even opened", async () => {
  // Not a micro-optimization: the refusal needs nothing from the database, and a
  // caller must not be able to spend a connection per rejected call.
  const rpc = await handleRpc(
    () => Promise.reject(new Error("context must not be constructed")),
    "write",
    "tools/call",
    { name: "put_page", arguments: { slug: " memory/vault/whatever", body: "b" } },
  );
  const result = rpc.result as { content: { text: string }[]; isError: boolean };
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/reserved/);
});

// Any arg that NAMES a page. The namespace decision is DECLARED per tool and
// enforced by one loop in tools/call, so the only way left to re-open the door is
// a new write tool that never decides — which this fails on.
const PAGE_ARGS = ["slug", "to"];
// The single deliberate exemption: a projection page is derived, so delete_page is
// a cache eviction the next maintenance pass undoes (pinned by the delete_page
// rebuild test below).
const RESERVED_EXEMPT = new Set(["delete_page"]);

test("every write tool that names a page declares its reserved-namespace policy", () => {
  const decided: string[] = [];
  for (const [name, def] of Object.entries(TOOLS)) {
    if (def.access !== "write" || RESERVED_EXEMPT.has(name)) continue;
    const named = Object.keys(
      (def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    ).filter((p) => PAGE_ARGS.includes(p));
    if (!named.length) continue;
    for (const arg of named) {
      expect(
        def.reserved?.[arg],
        `${name}.${arg} does not decide the memory/ namespace`,
      ).toBeTypeOf("string");
    }
    decided.push(name);
  }
  // Not vacuous: the three tools that can create, move or revive a page are here.
  expect(decided.sort()).toEqual(["put_page", "rename_page", "restore_page"]);
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

// One RPC call per attempt, so the assertion is about what the tool surface allows
// rather than about what a handler happens to do when called directly.
function refuseTool(ctx: { db: Db; store: Store }) {
  return async (name: string, args: Record<string, unknown>, expected: RegExp) => {
    const rpc = await handleRpc(() => Promise.resolve(ctx), "write", "tools/call", {
      name,
      arguments: args,
    });
    const result = rpc.result as { content: { text: string }[]; isError: boolean };
    const at = `${name} ${JSON.stringify(args)}`;
    expect(result.isError, `${at} was ALLOWED`).toBe(true);
    expect(result.content[0].text, at).toMatch(expected);
  };
}

// The refutation, re-run against real SQL: the reviewer squatted the namespace with
// a single leading space, because the door read the caller's string and the row was
// written from its trim(). Every shape they used, on every end, and then their own
// assertion — which pages are LIVE under memory/ afterwards.
test("no whitespace spelling of a memory/ slug can squat or move a projection", async () => {
  await withBrain(async (ctx) => {
    const call = callTool(ctx);
    const refuse = refuseTool(ctx);
    const saved = (await call("remember", {
      content: "Kyoto hojicha is the evening cup.",
      scope: "vault",
    })) as { saved: boolean; memory_id: string };
    expect(saved.saved).toBe(true);
    const slug = `memory/vault/${saved.memory_id}`;
    await call("put_page", { slug: "notes/mine", body: "a real note" });

    for (const ws of WHITESPACE) {
      await refuse("put_page", { slug: `${ws}memory/vault/squat`, body: "squat" }, /reserved/);
      await refuse("put_page", { slug: `memory/vault/squat${ws}`, body: "squat" }, /reserved/);
      // The OWNED slug, whitespace-spelled: this is the write whose upsert cleared
      // deleted_at and put a retracted projection back into search.
      await refuse("put_page", { slug: `${ws}${slug}`, body: "forged" }, /reserved/);
      await refuse(
        "rename_page",
        { slug: `${ws}${slug}`, to: "notes/kidnapped" },
        /cannot be renamed/,
      );
      await refuse(
        "rename_page",
        { slug: "notes/mine", to: `${ws}memory/vault/squat` },
        /reserved/,
      );
    }
    // A non-string is the same bypass by coercion — String([" memory/vault/x"]) is
    // untrimmed again. Read as the store reads it, it names nothing at all.
    await refuse("rename_page", { slug: [` ${slug}`], to: "notes/kidnapped" }, /not_found/);

    // The store's half, reached PAST the door: if it stopped refusing, this door
    // would be the only thing left — which is the shape round 1 shipped and lost.
    await expect(ctx.store.putPage({ slug: " memory/vault/squat", body: "x" })).rejects.toThrow(
      /reserved/,
    );
    await expect(
      ctx.store.renamePage({ slug: "notes/mine", to: "\tmemory/vault/squat" }),
    ).rejects.toThrow(/reserved/);

    // The reviewer's list. Exactly one live page under memory/, and a committed
    // memory owns it — no unowned page inside the reserved namespace.
    const live = await ctx.db.query(
      "SELECT slug FROM pages WHERE slug LIKE 'memory/%' AND deleted_at IS NULL ORDER BY slug",
    );
    expect(live.rows.map((r) => String(r.slug))).toEqual([slug]);
    const owned = await ctx.db.query(
      "SELECT p.slug FROM memory_items m JOIN pages p ON p.id = m.projection_page_id WHERE m.id = $1",
      [saved.memory_id],
    );
    expect(String(owned.rows[0].slug)).toBe(slug);
    // And the user's own page was neither moved nor clobbered on the way through.
    expect((await ctx.store.getPage({ slug: "notes/mine" })).body).toBe("a real note");
  });
});

// restore_page is the door with NO second half behind it: store.restorePage MUST
// accept a committed memory's page, because that is the projection sweep's own
// revive path (projection.ts calls it before re-putting). So every spelling has to
// die here, and only a maintenance pass may bring the page back.
test("a retracted projection is revived by the sweep, never by restore_page", async () => {
  await withBrain(async (ctx) => {
    const call = callTool(ctx);
    const refuse = refuseTool(ctx);
    const saved = (await call("remember", {
      content: "Oaxaca cascara is the summer cooler.",
      scope: "vault",
    })) as { memory_id: string };
    const slug = `memory/vault/${saved.memory_id}`;
    expect((await call("delete_page", { slug })).deleted).toBe(true);

    for (const ws of WHITESPACE) {
      await refuse("restore_page", { slug: `${ws}${slug}` }, /maintenance pass/);
      await refuse("restore_page", { slug: `${slug}${ws}` }, /maintenance pass/);
    }
    await refuse("restore_page", { slug }, /maintenance pass/);

    const live = await ctx.db.query(
      "SELECT slug FROM pages WHERE slug LIKE 'memory/%' AND deleted_at IS NULL",
    );
    expect(live.rows).toEqual([]);
    expect(await searchText(ctx.store, "Oaxaca cascara")).not.toContain("cascara");

    // The one path that may bring it back still does.
    expect((await runProjections(ctx.db, ctx.store, 50)).projected).toBe(1);
    expect(await searchText(ctx.store, "Oaxaca cascara")).toContain("cascara");
  });
});
