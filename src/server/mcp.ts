// MCP surface of the standalone brain: the read tools lore calls (bare gbrain
// names, same shapes) plus the write tools for agents. One registry drives
// tools/list and tools/call; access is decided by the caller's bearer grant.

import type { Db } from "./db";
import { isMemorySlug } from "./memory/projection";
import { isScopedProjection } from "./memory/projection";
import { MEMORY_TOOLS } from "./memory/tools";
import { type PageHit, type Store, normalizePageSlug } from "./store";

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
  // Args that NAME a page and must never name one inside the reserved memory/
  // namespace: arg -> the clause its refusal reads with. DECLARED here and
  // enforced once in tools/call (refuseReserved), not written into each handler:
  // the guards this replaces were per-handler, each read its own spelling of the
  // slug, and one leading space walked past three of them at once.
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
      "back. A memory/ projection page is derived, so deleting one only clears it until the next " +
      "maintenance pass rebuilds it — revoke the memory with forget instead.",
    inputSchema: obj({ slug: { type: "string" } }, ["slug"]),
    // No `reserved` on purpose, and the one deliberate exemption: the page is a
    // derived artifact, so deleting a projection is a cache eviction, not a
    // revocation — the next maintenance pass rebuilds it (pinned in
    // tests/brain-mcp.test.ts, which also holds the exemption list).
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

// The reserved memory/ namespace, refused at the door on EXACTLY the string the
// store will persist — before a database connection is even opened, since the
// decision needs nothing from it. ONE loop over the tool's own declaration is the
// point: the guards this replaces lived in three handlers, each read
// String(a.slug) while the store read args.slug.trim(), and so
// put_page{slug:" memory/vault/<id>"} was not memory/-prefixed to any of them and
// was written as memory/vault/<id> anyway. A new write tool cannot re-open that by
// forgetting to copy an `if` — it either declares `reserved` or the registry test
// in tests/brain-mcp.test.ts fails.
// This is not a second source of truth: the rule is isMemorySlug (projection.ts)
// over normalizePageSlug (store.ts), the same two functions the store checks with.
// It is the outer door, and it is load-bearing where the store is deliberately
// permissive — renaming a projection OUT of memory/, and restoring the page of a
// still-committed memory.
function refuseReserved(def: ToolDef, args: Record<string, unknown>): void {
  for (const [arg, clause] of Object.entries(def.reserved ?? {})) {
    const slug = normalizePageSlug(args[arg]);
    if (isMemorySlug(slug)) throw new Error(`slug '${slug}' ${clause}`);
  }
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
// Which door the call came through. The page surface has no per-agent principal
// — one shared bearer serves every agent — so a scope predicate on page reads has
// nothing to filter against. What the two doors DO differ on is who is behind
// them: `owner` is the authenticated human's own console (/api/call, viewer
// session), `agents` is the shared brain bearer. Thread- and agent-scoped
// memories are the owner's to browse and NOT something an agent should reach by
// searching the shared graph, which is exactly the leak that made the extraction
// scope fix cosmetic: the memory row was correctly thread-scoped while search,
// list_pages{kind:"memory"}, get_page, get_recent_salience and find_orphans all
// handed the same content back to anyone.
export type Surface = "owner" | "agents";

// A result may name a page as `slug`, or as the `from_slug`/`to_slug` of a graph
// edge, at any depth. Anything naming a scoped projection is dropped from a list
// and turns a direct read into the literal `not_found:` string lore matches on —
// so an agent cannot even learn that another thread's memory exists, which is the
// same rule memory/tools.ts already enforces on the memory tools.
const SLUG_FIELDS = ["slug", "from_slug", "to_slug"] as const;

function namesScoped(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return SLUG_FIELDS.some((f) => typeof o[f] === "string" && isScopedProjection(o[f] as string));
}

function hideScoped(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => !namesScoped(v)).map(hideScoped);
  if (!value || typeof value !== "object") return value;
  if (namesScoped(value)) {
    // Direct read of a scoped page: indistinguishable from one that never existed.
    throw new Error(`not_found: ${(value as { slug?: string }).slug ?? "page"}`);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, hideScoped(v)]),
  );
}

export async function handleRpc(
  getCtx: () => Promise<BrainCtx>,
  access: Access,
  method: string,
  params: Record<string, unknown> | undefined,
  surface: Surface = "agents",
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
      if (def.access === "write" && access !== "write") {
        return { error: { code: -32602, message: `tool '${name}' requires write access` } };
      }
      try {
        const args = clampArgs(params?.arguments);
        // Every tools/call passes here, so this is the one place the namespace is
        // decided — and the handler below reads the same normalizePageSlug value.
        refuseReserved(def, args);
        const ctx = await getCtx();
        const value = await def.handler(ctx, args);
        // Filtered in the DISPATCHER, not in each handler: every tools/call
        // passes here, so a page tool added later is safe by default. Not in
        // store.ts either — recall generates its candidates with store.search,
        // so a store-level filter would blind recall exactly like not projecting
        // at all.
        return {
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(surface === "owner" ? value : hideScoped(value)),
              },
            ],
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
