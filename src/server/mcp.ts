// MCP surface of the standalone brain: the read tools lore calls (bare gbrain
// names, same shapes) plus three write tools for agents. One registry drives
// tools/list and tools/call; access is decided by the caller's bearer grant.

import type { Db } from "./db";
import { isMemorySlug } from "./memory/projection";
import { MEMORY_TOOLS } from "./memory/tools";
import type { PageHit, Store } from "./store";

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
  handler: (ctx: BrainCtx, args: Record<string, unknown>) => Promise<unknown>;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  ...(required.length ? { required } : {}),
});

async function searchHandler(ctx: BrainCtx, args: Record<string, unknown>): Promise<PageHit[]> {
  return ctx.store.search({ query: String(args.query ?? ""), limit: args.limit as number });
}

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
    handler: (c, a) => c.store.getPage({ slug: String(a.slug ?? ""), fuzzy: Boolean(a.fuzzy) }),
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
    handler: (c, a) => c.store.getBacklinks({ slug: String(a.slug ?? "") }),
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
        slug: String(a.slug ?? ""),
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
    handler: (c, a) => {
      // The memory/ namespace belongs to generated projections. A user page must
      // never be able to overwrite one, or a rebuild would clobber real notes.
      if (isMemorySlug(String(a.slug ?? ""))) {
        throw new Error(`slug '${String(a.slug)}' is reserved for generated memory projections`);
      }
      return c.store.putPage({
        slug: String(a.slug ?? ""),
        title: a.title as string | undefined,
        body: String(a.body ?? ""),
        kind: a.kind as "note" | "memory" | undefined,
        frontmatter: a.frontmatter as Record<string, unknown> | undefined,
      });
    },
  },
  delete_page: {
    access: "write",
    description:
      "Soft-delete a page by slug. The body and its links are kept, so restore_page can bring it back.",
    inputSchema: obj({ slug: { type: "string" } }, ["slug"]),
    handler: (c, a) => c.store.deletePage({ slug: String(a.slug ?? "") }),
  },
  rename_page: {
    access: "write",
    description:
      "Change a page's slug. Links keep working: the old slug becomes an alias of the page, " +
      "and other pages' bodies are left untouched.",
    inputSchema: obj({ slug: { type: "string" }, to: { type: "string" } }, ["slug", "to"]),
    handler: (c, a) => c.store.renamePage({ slug: String(a.slug ?? ""), to: String(a.to ?? "") }),
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
    description: "Undo a delete_page: brings the page back and re-indexes it for search.",
    inputSchema: obj({ slug: { type: "string" } }, ["slug"]),
    handler: (c, a) => c.store.restorePage({ slug: String(a.slug ?? "") }),
  },
};

// Object.assign rather than a spread inside the literal so the memory tools are
// visibly a separate module's contribution to one registry.
Object.assign(TOOLS, MEMORY_TOOLS);

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

export interface RpcResult {
  result?: unknown;
  error?: { code: number; message: string };
  notification?: boolean;
}

// Dispatch one JSON-RPC method. Tool-level failures (including not_found) are
// MCP tool results with isError:true — not JSON-RPC errors — matching what
// lore and MCP clients expect. The store is fetched lazily so handshake
// methods (initialize/tools/list/ping) never touch the database.
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
      if (def.access === "write" && access !== "write") {
        return { error: { code: -32602, message: `tool '${name}' requires write access` } };
      }
      try {
        const ctx = await getCtx();
        const value = await def.handler(ctx, clampArgs(params?.arguments));
        return {
          result: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false },
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
