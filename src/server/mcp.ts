// MCP surface of the standalone brain: the read tools lore calls (bare gbrain
// names, same shapes) plus the write tools for agents. One registry drives
// tools/list and tools/call; access is decided by the caller's bearer grant.

import type { Db } from "./db";
import { isMemorySlug } from "./memory/projection";
import { findSecretsInPayload } from "./memory/safety";
import { MEMORY_TOOLS } from "./memory/tools";
import { extractRefs } from "./pipeline";
import { type PageHit, type Store, normalizePageSlug } from "./store";
import { refAddress } from "./vault";

export type Access = "read" | "write";

// Tools get the store for pages and the raw db for canonical memory. Anything
// that needs both (the memory tools) is written against this, not against a
// second connection of its own.
export interface BrainCtx {
  store: Store;
  db: Db;
}

export interface ToolDef {
  access: Access;
  description: string;
  inputSchema: Record<string, unknown>;
  // WORDING ONLY. Every argument of every WRITE tool is refused when it names a
  // page in the reserved memory/ namespace (refuseReserved); this map just picks
  // the sentence for the args where the generic one would mislead. It does NOT
  // pick which args are checked — an opt-in list is what left delete_page
  // unguarded, since a list only guards what someone remembered to add.
  reserved?: Record<string, string>;
  handler: (ctx: BrainCtx, args: Record<string, unknown>) => Promise<unknown>;
}

// The one sentence that says "you may not name a page here". store.ts's putPage
// raises the same clause for the same rule, so the two doors cannot describe the
// namespace differently.
const RESERVED = "is reserved for generated memory projections";

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  ...(required.length ? { required } : {}),
});

async function searchHandler(ctx: BrainCtx, args: Record<string, unknown>): Promise<PageHit[]> {
  return ctx.store.search({ query: String(args.query ?? ""), limit: args.limit as number });
}

// Every arg that NAMES a page is read through normalizePageSlug — the store's OWN
// normalizer, imported rather than re-spelled — so the string this door decides on
// and the string the row is written from are the same string, for every input
// shape. String(a.slug) is what made them differ: it kept the whitespace trim()
// removes, and it also turns a non-string ([" memory/vault/x"]) back into an
// untrimmed one. normalizePageSlug folds a non-string to "", which the store
// refuses as an invalid slug.
export const TOOLS: Record<string, ToolDef> = {
  list_pages: {
    access: "read",
    description: "List pages, most recently updated first. kind narrows to 'memory' or 'note'.",
    inputSchema: obj({
      limit: { type: "number" },
      sort: { type: "string" },
      kind: { type: "string", enum: ["note", "memory"] },
    }),
    // ponytail: sort is accepted but always updated_desc — the only order lore asks for.
    handler: (c, a) => c.store.listPages({ limit: a.limit as number, kind: a.kind as string }),
  },
  get_page: {
    access: "read",
    description: "Fetch one page by slug (fuzzy falls back to title match).",
    inputSchema: obj({ slug: { type: "string" }, fuzzy: { type: "boolean" } }, ["slug"]),
    handler: (c, a) =>
      c.store.getPage({ slug: normalizePageSlug(a.slug), fuzzy: Boolean(a.fuzzy) }),
  },
  search: {
    access: "read",
    description: "Hybrid search (vector + keyword + trigram, rank-fused).",
    inputSchema: obj({ query: { type: "string" }, limit: { type: "number" } }, ["query"]),
    handler: searchHandler,
  },
  query: {
    access: "read",
    description: "Alias of search.",
    inputSchema: obj({ query: { type: "string" }, limit: { type: "number" } }, ["query"]),
    handler: searchHandler,
  },
  get_backlinks: {
    access: "read",
    description: "Pages that link to the given slug.",
    inputSchema: obj({ slug: { type: "string" } }, ["slug"]),
    handler: (c, a) => c.store.getBacklinks({ slug: normalizePageSlug(a.slug) }),
  },
  traverse_graph: {
    access: "read",
    description: "Edges reachable from a slug, as {from_slug,to_slug} rows.",
    inputSchema: obj(
      { slug: { type: "string" }, depth: { type: "number" }, direction: { type: "string" } },
      ["slug"],
    ),
    handler: (c, a) =>
      c.store.traverseGraph({
        slug: normalizePageSlug(a.slug),
        depth: a.depth as number,
        direction: a.direction as string,
      }),
  },
  sources_list: {
    access: "read",
    description: "The single source of this standalone brain.",
    inputSchema: obj({}),
    handler: async (c) => ({
      sources: [
        {
          id: "default",
          name: process.env.APP_TITLE ?? "brain",
          page_count: await c.store.pageCount(),
        },
      ],
    }),
  },
  get_recent_salience: {
    access: "read",
    description: "Recently updated pages.",
    inputSchema: obj({ days: { type: "number" }, limit: { type: "number" } }),
    handler: (c, a) => c.store.recentPages({ days: a.days as number, limit: a.limit as number }),
  },
  put_page: {
    access: "write",
    description:
      "Create or update a page (upsert by slug). Markdown body; [[wikilinks]] become graph edges. " +
      "frontmatter.related_ids (slugs) add explicit edges. Omitted fields are left as they were, " +
      "so editing a memory's body keeps its kind and metadata; pass frontmatter: {} to clear it. " +
      "Refs are resolved by slug, title, filename or alias; the response's `pending` array lists " +
      "any that matched nothing, so you can correct them in the same turn.",
    inputSchema: obj(
      {
        slug: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        kind: { type: "string", enum: ["note", "memory"] },
        frontmatter: { type: "object" },
      },
      ["slug", "body"],
    ),
    // The memory/ namespace belongs to generated projections. A user page must
    // never be able to overwrite one, or a rebuild would clobber real notes.
    reserved: { slug: RESERVED },
    handler: (c, a) =>
      c.store.putPage({
        slug: normalizePageSlug(a.slug),
        title: a.title as string | undefined,
        body: String(a.body ?? ""),
        kind: a.kind as "note" | "memory" | undefined,
        frontmatter: a.frontmatter as Record<string, unknown> | undefined,
      }),
  },
  delete_page: {
    access: "write",
    description:
      "Soft-delete a page by slug. The body and its links are kept, so restore_page can bring it " +
      "back. A memory/ projection page belongs to its memory: revoke it with forget, which is " +
      "scoped, instead.",
    inputSchema: obj({ slug: { type: "string" } }, ["slug"]),
    // The old exemption ("a projection is derived, so deleting it is only a cache
    // eviction the sweep undoes") ignored who was holding the eviction lever: a
    // caller who knows nothing but a memory id could take that memory out of its
    // owner's retrieval until the next pass, and was answered 'not_found' — the
    // same text as a miss — because the filter ran on the RESULT, after the row
    // had already been updated. forget is the revocation path and it checks scope
    // BEFORE it acts; this door now refuses instead of racing a sweep.
    reserved: {
      slug: "is a generated memory projection: revoke it with forget, not delete_page",
    },
    handler: (c, a) => c.store.deletePage({ slug: normalizePageSlug(a.slug) }),
  },
  rename_page: {
    access: "write",
    description:
      "Change a page's slug. Links keep working: the old slug becomes an alias of the page, " +
      "and other pages' bodies are left untouched. The memory/ namespace is closed at BOTH " +
      "ends: a generated projection cannot be moved out of it, and no page can be moved in.",
    inputSchema: obj({ slug: { type: "string" }, to: { type: "string" } }, ["slug", "to"]),
    // Both directions, not just the destination. Moving a projection OUT is the
    // worse half, and the half the store deliberately still allows (its retraction
    // path is tested by putting a projection outside memory/, the way a database
    // written before this guard already looks): forget retracts the page its memory
    // owns, and a page nothing owns keeps answering search — revocation defeated
    // permanently. `slug` first, so a call that abuses both ends names the worse one.
    reserved: {
      slug: "is a generated memory projection and cannot be renamed",
      to: RESERVED,
    },
    handler: (c, a) =>
      c.store.renamePage({ slug: normalizePageSlug(a.slug), to: normalizePageSlug(a.to) }),
  },
  find_orphans: {
    access: "read",
    description: "Pages nothing links to.",
    inputSchema: obj({ limit: { type: "number" } }),
    handler: (c, a) => c.store.findOrphans({ limit: a.limit as number }),
  },
  list_broken_links: {
    access: "read",
    description: "Refs that point at a page which does not exist, as {from_slug, ref} rows.",
    inputSchema: obj({ limit: { type: "number" } }),
    handler: (c, a) => c.store.brokenLinks({ limit: a.limit as number }),
  },
  restore_page: {
    access: "write",
    description:
      "Undo a delete_page: brings the page back and re-indexes it for search. Refuses a " +
      "memory/ projection — a maintenance pass rebuilds those.",
    inputSchema: obj({ slug: { type: "string" } }, ["slug"]),
    // A deleted memory/ page was almost always deleted BY the projection lifecycle,
    // because its memory was retired. Restoring it puts a revoked fact back into
    // search. The store cannot refuse this one — its own revive path (projectMemory)
    // calls restorePage on a committed memory's page, so an owned slug is legal
    // there — which makes this door the ONLY thing standing between a caller and a
    // resurrected projection. Rebuilding one is a maintenance pass; restore_page is
    // for user pages.
    reserved: {
      slug: "is a generated memory projection: rebuild it with a maintenance pass, not restore_page",
    },
    handler: (c, a) => c.store.restorePage({ slug: normalizePageSlug(a.slug) }),
  },
  remember_note: {
    access: "write",
    description:
      "Save one atomic note page (auto-slugged mem-<uuid>). Metadata rides as frontmatter, and an " +
      "exact repeat returns the existing page instead of a second copy. For durable agent memory " +
      "with provenance, supersession and scope, use `remember` instead.",
    inputSchema: obj({ memory: { type: "string" }, metadata: { type: "object" } }, ["memory"]),
    handler: (c, a) =>
      c.store.remember({
        memory: String(a.memory ?? ""),
        metadata: a.metadata as Record<string, unknown> | undefined,
      }),
  },
};

// One name, one tool. A bare Object.assign overwrites a same-named page tool with
// no signal whatsoever — which is how the page-level `remember` disappeared behind
// the memory one (it is `remember_note` now). A collision is a bug in the
// registry, so it fails at import instead of silently hiding a tool.
export function mergeTools(
  base: Record<string, ToolDef>,
  extra: Record<string, ToolDef>,
): Record<string, ToolDef> {
  for (const name of Object.keys(extra)) {
    if (name in base) throw new Error(`duplicate MCP tool name '${name}': rename one of them`);
  }
  return Object.assign(base, extra);
}

mergeTools(TOOLS, MEMORY_TOOLS);

export const READ_TOOL_NAMES = Object.keys(TOOLS).filter((t) => TOOLS[t].access === "read");

const MAX_BOUND = 200;
const BOUNDED = ["limit", "depth", "max", "top_k", "k", "days"];

export function clampArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null) return {};
  const out = { ...(args as Record<string, unknown>) };
  for (const key of BOUNDED) {
    if (typeof out[key] === "number" && out[key] > MAX_BOUND) out[key] = MAX_BOUND;
  }
  return out;
}

// The slug a ref ADDRESSES, decided by the store's own definition rather than by a
// second spelling of it: refAddress (vault.ts) is the ONE transform that turns a
// name into a slug, shared with the importer that named the page in the first
// place, and store.ts's resolveRef asks it the same question one line before it
// looks a page up. Two readers of this value is the defect this whole round is
// about, and this door has BEEN the second reader twice:
//   - it kept the empty first segment a leading '/' leaves, while the store
//     stripped './' '../' and '/' as noise — so isMemorySlug('/memory/vault/<id>')
//     was false and [[/memory/vault/<id>]] minted the edge every other spelling
//     was refused for;
//   - it folded the whole string with normalizeRef while the store folded PER
//     SEGMENT, so [[memory / vault / <id>]] — the spaces a human types around a
//     wikilink's separators — read as 'memory / vault / …' here and as the
//     projection's own address there.
// Neither can happen now: there is nothing here to disagree with.
//
// `null` means the ref has no separator, so it addresses nothing — "" is the right
// answer for a prefix test, since no page's slug is empty. A NAME can still reach a
// projection through the basename arm ([[<uuid>]]), which no string test at a door
// can know about because it is a database question; that residual is pinned by "a
// scoped memory is indistinguishable from a memory that does not exist".
function refForm(s: string): string {
  return refAddress(s) ?? "";
}

// Does this value NAME a page in the reserved memory/ namespace — anywhere
// inside it, at any depth, in a key or a value? Read every way the STORE reads a
// name, using the store's own readers rather than a second spelling:
//   - as a slug, through normalizePageSlug: the exact string a row is written
//     from (which is why " memory/vault/x" is not a way in);
//   - as a ref, through refForm/refAddress above (so case, quoting, NFKC, .md,
//     './' '../' and a leading '/' are not);
//   - as TEXT THAT CONTAINS refs, through extractRefs: the very function putPage
//     calls to turn a body and its frontmatter into edges, so a [[wikilink]] or a
//     Markdown link is caught by the same parser that would have minted the edge
//     — and a wikilink inside a code fence, which that parser masks, correctly
//     names nothing here because it names nothing there either.
// The last arm is the one a declared-arg check could never have: the door read
// `slug`, so put_page{body:'x [[memory/scoped/<id>]]'} linked into the namespace
// and reported back whether the ref resolved — an existence oracle on a raw id.
//
// BOTH spellings of every extracted ref, because the store's address lookup takes
// BOTH (addressCandidates in store.ts): the literal slug and the canonical address.
// A ref whose literal spelling is a reserved slug but whose canonical address is
// not — refAddress answers "" when canonicalizing would DELETE a character, e.g.
// 'memory/vault/x%y' — would otherwise be read by this door as naming nothing while
// the store still tried it as a slug. (The third candidate, the address in NFD, can
// only start with 'memory/' when the composed one does: the prefix is ASCII.)
function reservedNameIn(value: unknown): string | null {
  if (typeof value === "string") {
    for (const name of [normalizePageSlug(value), refForm(value)]) {
      if (isMemorySlug(name)) return name;
    }
    for (const ref of extractRefs(value)) {
      for (const name of [normalizePageSlug(ref), refForm(ref)]) {
        if (isMemorySlug(name)) return name;
      }
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = reservedNameIn(v);
      if (found !== null) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const found = reservedNameIn(k) ?? reservedNameIn(v);
      if (found !== null) return found;
    }
  }
  return null;
}

// The reserved memory/ namespace, refused at the door — before a database
// connection is even opened, since the decision needs nothing from one, and
// before the handler, because a rule that runs after the write is not a rule
// (that ordering is exactly how delete_page mutated the row and then answered
// 'not_found').
//
// DEFAULT DENY over every argument of every write tool, not an opt-in list of
// args. The list shape has now failed twice for the same reason: it guards the
// entries someone remembered, and the next caller uses the entry they did not —
// `slug` was guarded while `body`, `frontmatter.related_ids`, `frontmatter
// .aliases` and delete_page's own slug were not. There is nothing to forget to
// add now: a tool is either a READ, or it may not name a reserved page anywhere.
// Reads may name one on purpose — the console opens a vault memory's page by slug.
//
// Not a second source of truth: the rule is isMemorySlug (projection.ts) over the
// store's own normalizers. It is the outer door, load-bearing where the store is
// deliberately permissive — renaming a projection OUT of memory/, restoring the
// page of a still-committed memory, and deleting a projection the store treats as
// an ordinary page.
function refuseReserved(def: ToolDef, args: Record<string, unknown>): void {
  if (def.access !== "write") return;
  const seen = new Set<string>();
  // Declared args first, so a call that abuses two ends is named by the worse one
  // (rename_page's `slug` before its `to`) whatever order the JSON arrived in.
  for (const arg of [...Object.keys(def.reserved ?? {}), ...Object.keys(args)]) {
    if (seen.has(arg)) continue;
    seen.add(arg);
    const named = reservedNameIn(args[arg]);
    if (named !== null) throw new Error(`slug '${named}' ${def.reserved?.[arg] ?? RESERVED}`);
  }
}

// No credential may enter this system through ANY field of ANY WRITE.
//
// The per-field gate has now been defeated three times with one move: it was
// wired to `content`, then to `structured_value`, then to `memory_key`, and the
// credential simply moved to thread_id / actor_id / trace_id / idempotency_key /
// memory_revisions.reason. Every one of those is TEXT in ddl.ts and every one was
// reached by a handler that had already appended an immutable event before
// anything was screened — so the detector fired, the write was "rejected", and
// the secret was in the log anyway. There is no list of fields to complete here;
// there is one place every agent-supplied byte arrives, and this is it.
//
// WRITE tools, not every method — NARROWED, and this is the one direction it may
// be narrowed in. The screen used to run for every method over the whole params
// object, and that cost a wedge with no matching gain: import
// 'Receipts/4111111111111111.md' (an honest vault filename; Luhn-valid, so
// payment_card fires) and the page exists, list_pages hands back its slug, and
// then every tool that NAMES that slug is refused — the user's own note can never
// be opened, searched or read again through the only surface the console has.
// Nothing durable is written by a read: `access` is the same static field the gate
// below and refuseReserved already trust to mean "this tool cannot write", every
// read tool in the registry only SELECTs (resolveCallScope's getThread included),
// and the console's in-memory request log records tool NAMES, not arguments. So
// this is not an ad-hoc carve-out of tools someone judged safe; it is the entry
// rule applied to the entries. `initialize`, `ping`, `tools/list` and an unknown
// tool name persist nothing either, and are no longer screened for the same
// reason.
//
// What that leaves, stated plainly because it is a real cost and not a gap: a
// page whose SLUG contains a credential-shaped run — a legacy row, or one a
// pre-screen release wrote — is readable again but still cannot be deleted or
// renamed, because delete_page and rename_page are writes and a slug is bytes.
// The alternative is a list of write arguments that are safe to carry a
// credential, which is precisely the shape that lost three times above.
//
// Decided on the tool's OWN access, never on the caller's grant, so a read-token
// holder naming put_page is screened here rather than talked out of it later.
//
// REFUSE, never rewrite. At the dispatcher there is no way to know which field is
// safe to mangle, and safety.ts's own note says why partial rewriting has no
// correct form: a detector matches a marker, not the extent of a secret. Only the
// finding's KIND is reported — the value is never echoed back into a log line.
function secretRefusal(params: unknown): string | null {
  const findings = findSecretsInPayload(params);
  if (!findings.length) return null;
  const kinds = findings.map((f) => f.kind).join(", ");
  return `refused: request contains ${kinds} — credentials are never accepted as input`;
}

export interface RpcResult {
  result?: unknown;
  error?: { code: number; message: string };
  notification?: boolean;
}

// Dispatch one JSON-RPC method. Tool-level failures (including not_found) are
// MCP tool results with isError:true — not JSON-RPC errors — matching what
// lore and MCP clients expect. The store is fetched lazily so handshake
// methods (initialize/tools/list/ping) never touch the database.
//
// There is deliberately NO result filter here any more. The `hideScoped` pass
// that used to sit on the way out was a filter over content that had already
// been projected into the shared page/FTS/edge space, and every hole in it was a
// consequence of leaking first and hiding after: it threw not_found naming the
// REAL page's slug (a substring oracle over the very content it was hiding, plus
// the memory's uuid), it dropped array elements at one depth and threw at
// another (so one append_event payload poisoned an immutable thread forever),
// and page_count and the rrf denominator still counted what it had removed.
// projection.ts no longer puts thread- and agent-scoped memories into that space
// at all, and recall.ts reads memory_items directly, so there is nothing on the
// page surface left to hide — and no filter left to have holes.
//
// The rule kept from it, applied to every error path in this file: an error
// message must never echo a value the caller did not supply. The refusals below
// quote the caller's own tool name, method, and slug, and the secret refusal
// quotes only the KIND of what it found.
export async function handleRpc(
  getCtx: () => Promise<BrainCtx>,
  access: Access,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<RpcResult> {
  if (method?.startsWith("notifications/")) return { notification: true };
  switch (method) {
    case "initialize":
      return {
        result: {
          protocolVersion: (params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "lore-brain", version: "0.1.0" },
        },
      };
    case "ping":
      return { result: {} };
    case "tools/list": {
      const visible = Object.entries(TOOLS).filter(
        ([, def]) => access === "write" || def.access === "read",
      );
      return {
        result: {
          tools: visible.map(([name, def]) => ({
            name,
            description: def.description,
            inputSchema: def.inputSchema,
          })),
        },
      };
    }
    case "tools/call": {
      const name = String(params?.name ?? "");
      const def = TOOLS[name];
      if (!def) return { error: { code: -32602, message: `unknown tool '${name}'` } };
      // Screened and decided on the SAME object the handler is about to read:
      // clampArgs' output, not the raw params, so there is no second spelling
      // between the door and the write.
      const args = clampArgs(params?.arguments);
      // ONE screen, over that whole object, for every WRITE tool: above the access
      // gate, above refuseReserved, above any connection — and OUTSIDE the try, so
      // a payload too deep to walk leaves handleRpc instead of being caught into an
      // isError tool result that reads like an ordinary miss. -32602 rather than an
      // isError result because no tool ran; the access gate refuses this way too.
      if (def.access === "write") {
        const secrets = secretRefusal(args);
        if (secrets) return { error: { code: -32602, message: secrets } };
      }
      if (def.access === "write" && access !== "write") {
        return { error: { code: -32602, message: `tool '${name}' requires write access` } };
      }
      try {
        refuseReserved(def, args);
        const ctx = await getCtx();
        const value = await def.handler(ctx, args);
        return {
          result: {
            content: [{ type: "text", text: JSON.stringify(value) }],
            isError: false,
          },
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { result: { content: [{ type: "text", text: message }], isError: true } };
      }
    }
    default:
      return { error: { code: -32601, message: `method '${method}' not supported` } };
  }
}
