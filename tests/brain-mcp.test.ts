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
  // the store.
  // STRENGTHENED (was: the call went through and renamed nothing, because
  // normalizePageSlug folds a non-string to ""). The door now walks INTO the
  // array, so the element is read as the name it is and the call is refused
  // outright. Nothing loosened: a call that used to succeed harmlessly now fails.
  const coerced = await call("rename_page", { slug: [" memory/vault/squat"], to: "notes/free" });
  expect(coerced.isError).toBe(true);
  expect(coerced.content[0].text).toMatch(/cannot be renamed/);
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

// REPLACES "every write tool that names a page declares its reserved-namespace
// policy", which asserted that a DECLARATION existed for the args named `slug`
// and `to`. That test could only ever pin the list: delete_page was exempted from
// it by name, and no declaration was ever asked of `body`, `frontmatter` or an
// arg invented tomorrow. The rule is now default-deny for every argument of every
// write tool, so the test asserts the BEHAVIOUR, over the registry itself — a
// write tool added later is probed the day it is added, with no list to update.
const VICTIM = "memory/scoped/9b14a291-0000-4000-8000-000000000000";

// Fill a tool's required args so the call is well-formed; the probe rides in an
// argument the tool never declared.
function requiredArgs(def: ToolDef): Record<string, unknown> {
  const schema = def.inputSchema as {
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
  const out: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    const t = schema.properties?.[key]?.type;
    out[key] = t === "number" ? 1 : t === "boolean" ? true : t === "object" ? {} : "x";
  }
  return out;
}

// A context that must never be constructed: the refusal has to happen BEFORE the
// handler. A rule that runs after the write is not a rule — that ordering is
// exactly how delete_page mutated the row and then answered 'not_found'.
const noCtx = () => Promise.reject(new Error("context must not be constructed"));

test("no write tool accepts a reserved name in ANY argument, at any depth", async () => {
  // Every way a string can NAME a page, in an argument nobody declared: bare, in
  // a nested object, in an array, as an object KEY, as a [[wikilink]] inside
  // prose, as a Markdown link, and case-folded.
  const probes: Record<string, unknown>[] = [
    { probe: VICTIM },
    { probe: { deep: [{ deeper: VICTIM }] } },
    { probe: { [VICTIM]: "in the key" } },
    { probe: `see [[${VICTIM}]] for the rest` },
    { probe: `see [the note](${VICTIM}.md)` },
    { probe: ` ${VICTIM.toUpperCase()} ` },
  ];
  const covered: string[] = [];
  for (const [name, def] of Object.entries(TOOLS)) {
    if (def.access !== "write") continue;
    covered.push(name);
    for (const probe of probes) {
      const rpc = await handleRpc(noCtx, "write", "tools/call", {
        name,
        arguments: { ...requiredArgs(def), ...probe },
      });
      const result = rpc.result as { content: { text: string }[]; isError: boolean };
      const at = `${name} ${JSON.stringify(probe)}`;
      expect(result?.isError, `${at} was ALLOWED`).toBe(true);
      // Anything else — including "context must not be constructed" — means the
      // guard did not fire and the call went on to the handler.
      expect(result.content[0].text, at).toMatch(/reserved|cannot be renamed|forget/);
    }
  }
  // Not vacuous, and self-updating: every write tool the registry has.
  expect(covered).toEqual(Object.keys(TOOLS).filter((n) => TOOLS[n].access === "write"));
  expect(covered.length).toBeGreaterThanOrEqual(9);
});

// A read may name a projection on purpose: the console opens a vault memory's
// page by slug. Access is what decides, not a list of tools.
test("reads may still name a memory page", async () => {
  const rpc = await handleRpc(getCtx, "read", "tools/call", {
    name: "get_page",
    arguments: { slug: "memory/vault/abc" },
  });
  const result = rpc.result as { content: { text: string }[]; isError: boolean };
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content[0].text).slug).toBe("memory/vault/abc");
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

// --- Every agent-supplied byte is screened in the dispatcher ----------------
//
// The secret gate was defeated three times by the same move: it was wired to
// `content`, then to `structured_value`, then to `memory_key`, and the credential
// walked one field sideways each time — into thread_id, actor_id, trace_id,
// idempotency_key, memory_revisions.reason. tools/call is where every argument of
// every tool arrives, so the screen reads the WHOLE params object there.
const AWS = "AKIAIOSFODNN7EXAMPLE";
const GITHUB = "ghp_abcdefghijklmnopqrstuvwxyz012345";
const OPENAI = "sk-live-9QtbRm2ZxKw7Ns4Vd1PcLyHg";

// NARROWED with the screen: the read-tool cases that used to live in this list
// ("search"{query}, "get_page"{undeclared_field}, "list_events"{thread_id}) moved
// to the two tests at the bottom of this file, which assert the property that
// replaced them — a read is ALLOWED and persists nothing, probed over the whole
// read registry rather than over three hand-picked tools. The undeclared-field arm
// is kept here on a write tool, because "there is no list of fields" is the claim
// this test exists to hold.
test("a credential in ANY field of ANY WRITE tool is refused before the handler runs", async () => {
  const cases: [string, Record<string, unknown>][] = [
    // Verbatim from the review: the detector fired, the write was "rejected", and
    // the credential was in the append-only log anyway because the handler had
    // already appended the event.
    [
      "remember",
      {
        content: "The rotation runbook is in scripts/rotate.sh",
        scope: "agent",
        scope_id: "agent-1",
        thread_id: AWS,
      },
    ],
    ["append_event", { thread_id: "t", event_type: "tool_result", idempotency_key: `d-${GITHUB}` }],
    ["append_event", { thread_id: "t", event_type: "tool_result", actor_id: `runner-${AWS}` }],
    ["append_event", { thread_id: "t", event_type: "tool_result", trace_id: `trace-${OPENAI}` }],
    ["forget", { memory_id: "m1", scope: "vault", reason: `rotating: the old ${AWS} leaked` }],
    // ...and the fields nobody has named yet: nested, in an array, in a KEY, and in
    // an argument the schema does not even mention.
    ["put_page", { slug: "notes/a", body: "b", frontmatter: { deep: { list: [GITHUB] } } }],
    ["put_page", { slug: "notes/a", body: "b", frontmatter: { [AWS]: 1 } }],
    ["put_page", { slug: "notes/a", body: "b", undeclared_field: GITHUB }],
    ["delete_page", { slug: `receipts/${OPENAI}` }],
  ];
  for (const [name, args] of cases) {
    const rpc = await handleRpc(noCtx, "write", "tools/call", { name, arguments: args });
    const at = `${name} ${Object.keys(args).join(",")}`;
    expect(rpc.result, `${at} reached a handler`).toBeUndefined();
    expect(rpc.error?.message, at).toMatch(/refused: request contains/);
    // The refusal names the KIND and never the value: this string ends up in
    // logs, and a gate that echoes the credential is a second copy of it.
    for (const secret of [AWS, GITHUB, OPENAI]) {
      expect(rpc.error?.message, at).not.toContain(secret);
    }
  }
});

// CHANGED, and loosened in two arms on purpose — say so plainly. This used to
// assert that the screen ran for EVERY method: an unknown tool name and
// `initialize` were refused too. Neither reaches a handler, a store or a row, so
// screening them protected nothing durable, while screening every method cost the
// wedge pinned in "a page whose slug is credential-shaped" below — an honest page
// that could never be read again. The arm that MATTERS is unchanged, and is why
// this test still exists: the screen reads the TOOL's access, not the caller's
// grant, so a read-token holder naming a write tool is screened before the
// "requires write access" refusal can report anything back.
// REVERSED DELIBERATELY, and the old name was "the screen decides on the tool's
// own access, not the caller's grant". That ordering was chosen so a read-token
// holder naming put_page would be "screened here rather than talked out of it
// later" — and it made the screen, which walks every string leaf against every
// enclosing key, FREE TO THE ONE PARTY IT PROTECTS AGAINST. An adversarial pass
// measured a BRAIN_READ_TOKEN holder spending 7.4 seconds of server CPU on an
// 83KB payload before being told it lacked write access, 600 times a minute.
// A caller that cannot write has nothing for a credential to land in, so the
// grant is checked first and the screen is what a WRITER passes.
test("the grant is checked before the screen, and the screen still guards every write", async () => {
  const denied = await handleRpc(noCtx, "read", "tools/call", {
    name: "put_page",
    arguments: { slug: "notes/a", body: GITHUB },
  });
  // CHANGED: was /refused: request contains/. A read token is now turned away on
  // its grant, which is cheaper and tells it strictly less.
  expect(denied.error?.message).toMatch(/requires write access/);
  expect(denied.result, "reached a handler").toBeUndefined();
  // The half that must NOT change: a WRITE-granted call carrying the same
  // credential is still refused by the screen, above refuseReserved and above any
  // connection.
  const screened = await handleRpc(noCtx, "write", "tools/call", {
    name: "put_page",
    arguments: { slug: "notes/a", body: GITHUB },
  });
  expect(screened.error?.message).toMatch(/refused: request contains/);
  // Above refuseReserved as well: a call that trips both is refused as a
  // credential, and reaches neither a handler nor a connection either way.
  const both = await handleRpc(noCtx, "write", "tools/call", {
    name: "put_page",
    arguments: { slug: "memory/vault/abc", body: AWS },
  });
  expect(both.result, "reached a handler").toBeUndefined();
  expect(both.error?.message).toMatch(/refused: request contains/);
  // The methods that persist nothing are no longer screened, and must not error.
  const init = await handleRpc(noCtx, "read", "initialize", { clientInfo: { name: OPENAI } });
  expect(init.error).toBeUndefined();
  const unknown = await handleRpc(noCtx, "read", "tools/call", {
    name: "nope",
    arguments: { q: AWS },
  });
  expect(unknown.error?.message).toMatch(/unknown tool 'nope'/);
});

// The cost of screening everything a write carries is false refusals, so pin the
// near-misses safety.ts deliberately lets through — this must not become a door
// that refuses ordinary prose and ordinary ids.
// MOVED to put_page: the two prose cases used to ride on `search`, which is a read
// and is no longer screened at all, so they would have passed vacuously.
test("credential-SHAPED prose and handles are not refused", async () => {
  const ok = async (name: string, args: Record<string, unknown>) => {
    const rpc = await handleRpc(getCtx, "write", "tools/call", { name, arguments: args });
    expect(rpc.error, `${name} ${JSON.stringify(args)}`).toBeUndefined();
    return rpc.result as { content: { text: string }[]; isError: boolean };
  };
  const put = (body: string) => ok("put_page", { slug: "notes/a", body });
  expect((await put("the bearer of bad news")).isError).toBe(false);
  expect((await put("basic infrastructure requirements")).isError).toBe(false);
  // A millisecond timestamp inside a handle is not a payment card (the delimiter
  // guard in safety.ts), and one id in ten passes Luhn by chance.
  expect((await put("thread-1785550770695")).isError).toBe(false);
  expect((await ok("search", { query: "the bearer of bad news" })).isError).toBe(false);
});

// --- hideScoped is GONE ------------------------------------------------------
//
// It filtered content that had ALREADY been projected into the shared page / FTS
// / edge space, and every hole in it came from that ordering: it threw not_found
// naming the REAL page's slug (a substring oracle over the very content it was
// hiding, and a disclosure of the memory uuid), it dropped an array element at
// one depth and threw at another (so one append_event payload poisoned an
// immutable thread's reads forever), and page_count and the rrf denominator still
// counted what it had removed. projection.ts no longer puts thread- and
// agent-scoped memories on the page surface at all, so there is nothing left to
// filter — and no filter left to have holes.
test("the dispatcher returns handler results verbatim", async () => {
  const rows = [
    { slug: VICTIM, title: "top level" },
    { nested: { slug: VICTIM }, from_slug: "a", to_slug: VICTIM },
  ];
  const ctx = () =>
    Promise.resolve({
      store: { ...stub, listPages: async () => rows } as unknown as Store,
      db: stubDb,
    });
  const rpc = await handleRpc(ctx, "read", "tools/call", { name: "list_pages", arguments: {} });
  const result = rpc.result as { content: { text: string }[]; isError: boolean };
  expect(result.isError).toBe(false);
  // The old filter dropped the first row, then THREW on the second.
  expect(JSON.parse(result.content[0].text)).toEqual(rows);
});

test("a miss never echoes a value the caller did not supply", async () => {
  // The fuzzy-title oracle, verbatim: get_page{slug:'41-17', fuzzy:true} resolved
  // to a hidden page and the filter threw `not_found: memory/scoped/<uuid>` —
  // the resolved page's slug, which the caller never sent. Comparing that against
  // get_page{slug:'41-18'} -> `not_found: 41-18` read out the hidden content one
  // substring at a time.
  const ctx = () =>
    Promise.resolve({
      store: {
        ...stub,
        getPage: async () => ({ slug: VICTIM, title: "T", body: "B" }),
      } as unknown as Store,
      db: stubDb,
    });
  const rpc = await handleRpc(ctx, "read", "tools/call", {
    name: "get_page",
    arguments: { slug: "41-17", fuzzy: true },
  });
  const result = rpc.result as { content: { text: string }[]; isError: boolean };
  expect(result.isError).toBe(false);
  expect(result.content[0].text).not.toMatch(/not_found/);
});

test("unknown tools and methods are JSON-RPC errors; notifications pass through", async () => {
  const unknown = await handleRpc(getCtx, "write", "tools/call", { name: "nope", arguments: {} });
  expect(unknown.error?.code).toBe(-32602);
  const method = await handleRpc(getCtx, "write", "bogus/method", {});
  expect(method.error?.code).toBe(-32601);
  const note = await handleRpc(getCtx, "read", "notifications/initialized", undefined);
  expect(note.notification).toBe(true);
  // The one arm above the screen. It is safe to be above it only because it
  // reaches no handler and no store — pinned with a context that must not be
  // constructed, so a notification can never become a write channel.
  const smuggle = await handleRpc(noCtx, "write", "notifications/tools/call", {
    name: "remember",
    arguments: { content: AWS, scope: "vault" },
  });
  expect(smuggle).toEqual({ notification: true });
});

// The walks are recursive, so a pathological payload must fail CLOSED: the
// exception leaves handleRpc before any handler runs, rather than being caught
// into an allow.
test("a payload too deep to walk is refused, not waved through", async () => {
  let deep: unknown = "x";
  for (let i = 0; i < 20000; i++) deep = [deep];
  const rpc = await handleRpc(noCtx, "write", "tools/call", {
    name: "put_page",
    arguments: { slug: "notes/deep", body: "b", frontmatter: { deep } },
  }).catch((e) => ({ threw: e instanceof Error ? e.message : String(e) }));
  expect("result" in rpc && rpc.result).toBeFalsy();
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

// CHANGED from "delete_page on a committed projection is rebuilt by the next
// maintenance pass", which pinned the old exemption: a projection page was a
// cache entry any caller could evict, on the theory that the sweep rebuilds it.
// The reviewer showed what the exemption actually bought — a caller who holds
// nothing but a memory id takes that memory out of its owner's retrieval until
// the next pass and is answered 'not_found', the same text as a miss, so it reads
// as a no-op. The page is still derived and the sweep still rebuilds it; what
// changed is that this door no longer lets an agent start that race. Nothing
// loosened: a call that used to succeed now fails.
test("delete_page cannot evict a memory's projection; forget is the way out", async () => {
  await withBrain(async (ctx) => {
    const call = callTool(ctx);
    const refuse = refuseTool(ctx);
    const saved = (await call("remember", {
      content: "Lisbon cortado is the afternoon pour.",
      scope: "vault",
    })) as { memory_id: string };
    const slug = `memory/vault/${saved.memory_id}`;

    for (const spelling of [slug, ` ${slug}`, `${slug}\t`, [slug]]) {
      await refuse("delete_page", { slug: spelling }, /forget/);
    }
    // Refused BEFORE the UPDATE — the old filter ran on the RESULT, after the row
    // was already soft-deleted, which is why the caller got 'not_found' from a
    // call that had in fact succeeded.
    const row = await ctx.db.query("SELECT deleted_at FROM pages WHERE slug = $1", [slug]);
    expect(row.rows[0].deleted_at).toBe(null);
    expect(await searchText(ctx.store, "Lisbon cortado")).toContain("cortado");
    const health = await memoryHealth(ctx.db);
    expect([health.failed_projections, health.stale_active_projections]).toEqual([0, 0]);

    // An ordinary page still deletes, and the scoped revocation path still works.
    await call("put_page", { slug: "notes/ordinary", body: "an ordinary note" });
    expect((await call("delete_page", { slug: "notes/ordinary" })).deleted).toBe(true);
    expect((await call("forget", { memory_id: saved.memory_id, scope: "vault" })).forgotten).toBe(
      true,
    );
    expect(await searchText(ctx.store, "Lisbon cortado")).not.toContain("cortado");
  });
});

// The other half of chokepoint 3: refuseReserved read the declared `slug` arg, so
// a REF into the namespace — in the body, in related_ids, in aliases — walked
// straight past it, and put_page's own `pending` array then reported whether the
// ref resolved. That is an existence oracle on a raw out-of-scope id, from one
// call, with no need for get_backlinks at all.
test("no argument may link into the reserved namespace, so there is no oracle", async () => {
  await withBrain(async (ctx) => {
    const call = callTool(ctx);
    const refuse = refuseTool(ctx);
    const saved = (await call("remember", {
      content: "Trieste macchiato is the mid-morning break.",
      scope: "vault",
    })) as { memory_id: string };
    const slug = `memory/vault/${saved.memory_id}`;
    const absent = "memory/vault/00000000-0000-4000-8000-000000000000";

    for (const target of [slug, absent]) {
      // Every spelling the store's resolver folds to the same page. `../` was the
      // first one this door missed: foldPath drops leading dot segments before
      // matching, so [[../memory/vault/<id>]] resolves exactly like the bare form
      // while `startsWith("memory/")` said it was innocent.
      // The next two are the SAME defect one spelling further out, and both were
      // ALLOWED (isError:false, edge minted, `pending:[]` as the oracle):
      //   - a leading '/' left an EMPTY first segment that refForm kept, while
      //     foldPath strips './' '../' and '/' alike ("all noise");
      //   - foldPath folds per SEGMENT, so [[memory / vault / <id>]] — the spaces a
      //     human types — folded to the projection's own address in the store and
      //     to 'memory / vault / …' at the door.
      // tests below prove the store really does resolve each of these, which is
      // what makes refusing them load-bearing rather than decorative.
      for (const ref of [
        target,
        `../${target}`,
        `/${target}`,
        `//${target}`,
        `./${target}`,
        target.replace(/\//g, " / "),
        // NFKC folds a fullwidth solidus to '/', and normalizeRef runs NFKC — on
        // both sides, which is the only reason these two agree here.
        target.replace(/\//g, "／"),
        `${target}.md`,
        `${target}|see`,
        `${target}#top`,
        target.toUpperCase(),
        `'${target}'`,
      ]) {
        await refuse("put_page", { slug: "notes/probe", body: `x [[${ref}]]` }, /reserved/);
      }
      await refuse("put_page", { slug: "notes/probe", body: `x [see](${target}.md)` }, /reserved/);
      // The realistic spelling of the leading-slash bug: a Docusaurus/mkdocs export
      // writes root-relative Markdown links, which is the case foldPath's own
      // comment says it strips the '/' for.
      await refuse("put_page", { slug: "notes/probe", body: `x [see](/${target}.md)` }, /reserved/);
      for (const noisy of [`../${target}`, `/${target}`, target.replace(/\//g, " / ")]) {
        await refuse(
          "put_page",
          { slug: "notes/probe", body: "x", frontmatter: { related_ids: [noisy] } },
          /reserved/,
        );
      }
      // An alias would make every stale ref to that name resolve to the probe.
      await refuse(
        "put_page",
        { slug: "notes/probe", body: "x", frontmatter: { aliases: [target] } },
        /reserved/,
      );
    }
    // The refusals are IDENTICAL for a real id and an absent one, and nothing was
    // written either way — no page, no parked ref, no edge — so the caller has
    // nothing to measure the difference with.
    expect((await ctx.db.query("SELECT 1 FROM pages WHERE slug = 'notes/probe'")).rows).toEqual([]);
    expect((await ctx.db.query("SELECT target_ref FROM pending_links")).rows).toEqual([]);

    // A namespace rule, not a ban on links: the same wikilink elsewhere still works.
    const ok = await call("put_page", { slug: "notes/probe", body: "x [[notes/other]]" });
    expect(ok.slug).toBe("notes/probe");
    expect(ok.pending).toEqual(["notes/other"]);

    // A FENCED wikilink is allowed and names nothing — because extractRefs masks
    // code, the same masking that decides whether an edge is minted. The door and
    // the writer agree by construction, which is the reason to call the store's
    // own extractor instead of writing a pattern for "looks like a link".
    const fenced = await call("put_page", {
      slug: "notes/fenced",
      body: `documenting the syntax:\n\`\`\`\n[[${slug}]]\n\`\`\``,
    });
    expect(fenced.pending).toEqual([]);
    const refs = await ctx.db.query("SELECT target_ref FROM pending_links");
    expect(refs.rows.map((r) => String(r.target_ref))).toEqual(["notes/other"]);
  });
});

// The BOUNDARY, stated honestly and pinned. A ref can also reach a page by its
// BASENAME — [[<uuid>]] with no namespace at all resolves to memory/vault/<uuid>
// — and no string test at the door can know that, because "is this a page's
// basename" is a database question. That residual probe is not a confidentiality
// leak for one reason only, and it is the reason hideScoped could be deleted:
// a non-shared memory HAS NO PAGE, so the probe cannot distinguish one from a
// uuid that was never used. If that ever stops being true, this test fails.
test("a scoped memory is indistinguishable from a memory that does not exist", async () => {
  await withBrain(async (ctx) => {
    const call = callTool(ctx);
    const scoped = (await call("remember", {
      content: "Nairobi AA is what the other thread drinks.",
      scope: "thread",
      thread_id: "t-private",
    })) as { memory_id: string };
    const never = "00000000-0000-4000-8000-000000000000";

    const probe = async (id: string) =>
      (await call("put_page", { slug: `notes/probe-${id.slice(0, 8)}`, body: `[[${id}]]` }))
        .pending;
    // Identical answers: both refs stay parked, so nothing was there to link to.
    expect(await probe(scoped.memory_id)).toEqual([scoped.memory_id]);
    expect(await probe(never)).toEqual([never]);
    const pages = await ctx.db.query("SELECT slug FROM pages WHERE slug LIKE 'memory/%'");
    expect(pages.rows).toEqual([]);
    // ...and the content itself is not on the shared page surface either.
    expect(await searchText(ctx.store, "Nairobi AA")).not.toContain("Nairobi");
  });
});

// Every text-ish column of every table, read out of information_schema rather
// than listed: the refutations all landed in a column nobody had thought to
// check, so the assertion must not be a list of columns either.
async function occurrencesOf(db: Db, needle: string): Promise<string[]> {
  const cols = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('text','character varying','character','jsonb','json')
     ORDER BY table_name, column_name`,
  );
  const hits: string[] = [];
  for (const r of cols.rows) {
    const at = `"${String(r.table_name)}"."${String(r.column_name)}"`;
    // Identifiers come from the catalog, never from a caller.
    const res = await db.query(
      `SELECT count(*)::int AS n FROM ${at.split(".")[0]} WHERE ${at.split(".")[1]}::text LIKE '%' || $1 || '%'`,
      [needle],
    );
    if (Number(res.rows[0].n) > 0) hits.push(at);
  }
  return hits;
}

test("the refuted paths, re-run: a credential reaches NO column of ANY table", async () => {
  await withBrain(async (ctx) => {
    const call = callTool(ctx);
    const refuse = async (name: string, args: Record<string, unknown>) => {
      const rpc = await handleRpc(() => Promise.resolve(ctx), "write", "tools/call", {
        name,
        arguments: args,
      });
      expect(rpc.result, `${name} reached a handler`).toBeUndefined();
      expect(rpc.error?.message, name).toMatch(/refused: request contains/);
    };
    // A real, live memory to aim `forget` at, so its refusal cannot pass for a miss.
    const saved = (await call("remember", {
      content: "Rotation runbook lives in scripts/rotate.sh",
      scope: "vault",
    })) as { memory_id: string };

    await refuse("remember", {
      content: "The rotation runbook is in scripts/rotate.sh",
      scope: "agent",
      scope_id: "agent-1",
      thread_id: AWS,
    });
    await refuse("append_event", {
      thread_id: "t-delivery",
      event_type: "tool_result",
      content: "ok",
      idempotency_key: `delivery-${GITHUB}`,
      actor_id: `runner-${AWS}`,
      trace_id: `trace-${OPENAI}`,
    });
    await refuse("forget", {
      memory_id: saved.memory_id,
      scope: "vault",
      reason: `rotating because the old key ${AWS} leaked`,
    });

    for (const secret of [AWS, GITHUB, OPENAI]) {
      expect(await occurrencesOf(ctx.db, secret), secret).toEqual([]);
    }
    // The refused forget did not half-happen: the memory is still active and the
    // thread the refused append_event named was never created.
    expect(await searchText(ctx.store, "Rotation runbook")).toContain("runbook");
    expect((await ctx.db.query("SELECT id FROM threads WHERE id = 't-delivery'")).rows).toEqual([]);
    // Not vacuous: the same scan FINDS content that was legitimately stored.
    expect(await occurrencesOf(ctx.db, "Rotation runbook")).not.toEqual([]);
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
    // untrimmed again. STRENGTHENED (was /not_found/, i.e. the call reached the
    // store and named nothing there): the door now walks into the array and reads
    // the element, so this is refused at the door like every other spelling.
    await refuse("rename_page", { slug: [` ${slug}`], to: "notes/kidnapped" }, /cannot be renamed/);

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
    // Reach past the tool: delete_page refuses a projection outright now (see the
    // test above), and a retracted projection page is a state the SWEEP produces
    // when a memory is revoked — which is the state restore_page must not undo.
    await ctx.store.deletePage({ slug });

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

// --- The door and the store must fold a ref the SAME way ---------------------
//
// The other half of the reserved-namespace test above. Refusing a spelling is only
// load-bearing if the STORE resolves it, and that is exactly the disagreement this
// family of defect is made of: refForm read the whole string through normalizeRef
// while foldPath strips leading './' '../' '/' and folds PER SEGMENT. So every
// noise spelling the door now refuses for memory/ is proved here to mint a real
// edge for an ordinary address — same folding, nothing reserved about it.
test("the noise spellings the door refuses are spellings the store RESOLVES", async () => {
  await withBrain(async (ctx) => {
    const call = callTool(ctx);
    await call("put_page", { slug: "docs/target", body: "the target of every spelling" });
    const spellings = [
      "docs/target",
      "/docs/target",
      "//docs/target",
      "./docs/target",
      "../docs/target",
      "docs / target",
      "Docs / Target",
      "docs／target",
    ];
    for (const [i, ref] of spellings.entries()) {
      const from = `notes/from-${i}`;
      const put = await call("put_page", { slug: from, body: `see [[${ref}]]` });
      // Nothing parked: the ref landed on a page.
      expect(put.pending, ref).toEqual([]);
      const edges = await ctx.db.query(
        `SELECT pt.slug AS to_slug FROM edges e
         JOIN pages pf ON pf.id = e.from_page_id
         JOIN pages pt ON pt.id = e.to_page_id
         WHERE pf.slug = $1`,
        [from],
      );
      expect(
        edges.rows.map((r) => String(r.to_slug)),
        `[[${ref}]] must resolve to docs/target`,
      ).toEqual(["docs/target"]);
    }
  });
});

// --- Reads are not screened, and that is licensed by what a read can DO ------
//
// The screen runs for write tools only now. Two properties license it, and both
// are asserted rather than argued.
const CARD = "4111 1111 1111 1111";

// PROBED OVER THE REGISTRY, so a read tool added later — or one that grows a write
// tomorrow — is probed the day it lands, with no list to update. Every read tool
// gets a payload of credentials in its declared fields AND in one it never
// declared, and then every text-ish column of every table is scanned.
// THE SCREEN WAS FREE TO THE PARTY IT PROTECTS AGAINST. secretRefusal ran on the
// TOOL's access before the CALLER's grant was checked, and the walk it runs is
// O(leaves x depth) — so a BRAIN_READ_TOKEN holder, who cannot write anything,
// posted a deep payload naming put_page and spent seconds of server CPU before
// being told it lacked write access. Measured at 7.4s for 83KB nested 4,000 deep,
// against /api/mcp's 600 requests a minute. Two changes close it: the grant is
// checked first, and the walk is depth-bounded.
test("a read token cannot buy the credential walk, and the walk is bounded", async () => {
  await withBrain(async (ctx) => {
    // A payload engineered to be deep AND wide.
    let deep: Record<string, unknown> = { leaf: "value-here" };
    for (let i = 0; i < 3000; i++) deep = { [`k${i}`]: deep, [`leaf${i}`]: "value-here" };

    // Opening a context is itself work; if the read token never gets past the
    // grant check it must never reach one either.
    let opened = 0;
    const getCtx = async () => {
      opened++;
      return ctx;
    };

    const started = performance.now();
    const readCall = await handleRpc(getCtx, "read", "tools/call", {
      name: "put_page",
      arguments: { slug: "a/b", body: "x", frontmatter: deep },
    });
    const ms = performance.now() - started;
    expect(readCall.error?.message).toContain("requires write access");
    expect(opened, "a refused read opened a database context").toBe(0);
    // Generous by 20x: the point is that it is not seconds. Before the reorder
    // this same payload took ~4s and still ended in "requires write access".
    expect(ms, `the read token paid ${ms.toFixed(0)}ms of screening`).toBeLessThan(400);

    // The write token DOES get screened — the screen must not have been skipped
    // for everyone — and a payload too deep to walk is REFUSED rather than
    // crashing out of handleRpc as a 500.
    const writeCall = await handleRpc(getCtx, "write", "tools/call", {
      name: "put_page",
      arguments: { slug: "a/b", body: "x", frontmatter: deep },
    });
    expect(writeCall.error?.message).toMatch(/unscreenable_payload/);
    expect(writeCall.result, "an unscreenable payload reached a handler").toBeUndefined();
  });
});

// `TOOLS[name]` walked the prototype chain, so "constructor" was a known tool: it
// skipped the credential screen and the access gate (both read `def.access`,
// undefined on a function), skipped refuseReserved, and OPENED THE DATABASE
// before failing with "def.handler is not a function".
test("a prototype key is not a tool", async () => {
  await withBrain(async (ctx) => {
    let opened = 0;
    const getCtx = async () => {
      opened++;
      return ctx;
    };
    for (const name of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      const res = await handleRpc(getCtx, "read", "tools/call", { name, arguments: {} });
      expect(res.error?.message, name).toContain(`unknown tool '${name}'`);
      expect(res.result, name).toBeUndefined();
    }
    expect(opened, "an unknown tool name opened a database context").toBe(0);
    // MIRROR: a real tool still resolves and still runs.
    const ok = await handleRpc(getCtx, "read", "tools/call", {
      name: "list_pages",
      arguments: {},
    });
    expect(ok.error).toBeUndefined();
    expect(opened).toBe(1);
  });
});

test("every read tool takes a credential-shaped payload and persists nothing", async () => {
  await withBrain(async (ctx) => {
    for (const name of READ_TOOL_NAMES) {
      const args = {
        ...requiredArgs(TOOLS[name]),
        query: `${AWS} ${CARD}`,
        input: `${AWS} rotate it`,
        slug: `receipts/${GITHUB}`,
        memory_id: OPENAI,
        thread_id: `t-${AWS}`,
        undeclared_field: `${GITHUB} ${CARD}`,
      };
      const rpc = await handleRpc(() => Promise.resolve(ctx), "read", "tools/call", {
        name,
        arguments: args,
      });
      // A read may fail (not_found) — it may not be REFUSED, and it may not leave a
      // trace. isError is fine; a JSON-RPC error would mean the screen ran.
      expect(rpc.error, `${name} was refused`).toBeUndefined();
    }
    for (const secret of [AWS, GITHUB, OPENAI, "4111111111111111"]) {
      expect(await occurrencesOf(ctx.db, secret), secret).toEqual([]);
    }
    // Not vacuous: the scan finds content that WAS legitimately stored.
    await ctx.store.putPage({ slug: "notes/canary", body: "canary content" });
    expect(await occurrencesOf(ctx.db, "canary content")).not.toEqual([]);
  });
});

// THE WEDGE, which is what screening reads was costing: 'Receipts/4111…md' is an
// honest vault filename, Luhn-valid, so the slug itself trips payment_card. With
// the screen on every method, list_pages handed that slug back and then every tool
// that NAMED it was refused — the user's own note, permanently unopenable through
// the only surface the console has.
test("a page whose slug is credential-shaped can be read; writing one still cannot", async () => {
  await withBrain(async (ctx) => {
    const slug = "receipts/4111111111111111";
    // Past the door on purpose: this is the row a pre-screen release or the
    // unscreened importer left behind, and the state the screen wedged.
    await ctx.store.putPage({ slug, body: "annual renewal receipt" });
    const read = async (name: string, args: Record<string, unknown>) => {
      const rpc = await handleRpc(() => Promise.resolve(ctx), "read", "tools/call", {
        name,
        arguments: args,
      });
      expect(rpc.error, `${name} was refused`).toBeUndefined();
      return rpc.result as { content: { text: string }[]; isError: boolean };
    };
    const page = await read("get_page", { slug });
    expect(page.isError).toBe(false);
    expect(JSON.parse(page.content[0].text).body).toBe("annual renewal receipt");
    expect((await read("get_backlinks", { slug })).isError).toBe(false);
    expect((await read("traverse_graph", { slug })).isError).toBe(false);
    const listed = JSON.parse((await read("list_pages", {})).content[0].text) as { slug: string }[];
    expect(listed.map((p) => p.slug)).toContain(slug);

    // ...and the BOUNDARY, pinned rather than left to be discovered: a write naming
    // it is still refused, because a write may not carry credential bytes and a slug
    // is bytes. The alternative is a list of write arguments that are safe to carry
    // one, which is the shape that lost three times.
    for (const name of ["delete_page", "rename_page"]) {
      const rpc = await handleRpc(() => Promise.resolve(ctx), "write", "tools/call", {
        name,
        arguments: { slug, to: "receipts/renewal" },
      });
      expect(rpc.error?.message, name).toMatch(/refused: request contains payment_card/);
    }
  });
});
