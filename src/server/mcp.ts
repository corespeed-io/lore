// MCP surface of the standalone brain: the read tools lore calls (bare gbrain
// names, same shapes) plus three write tools for agents. One registry drives
// tools/list and tools/call; access is decided by the caller's bearer grant.

import type { PageHit, Store } from "./store";

export type Access = "read" | "write";

interface ToolDef {
  access: Access;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (store: Store, args: Record<string, unknown>) => Promise<unknown>;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  ...(required.length ? { required } : {}),
});

async function searchHandler(store: Store, args: Record<string, unknown>): Promise<PageHit[]> {
  return store.search({ query: String(args.query ?? ""), limit: args.limit as number });
}

export const TOOLS: Record<string, ToolDef> = {
  list_pages: {
    access: "read",
    description: "List pages, most recently updated first.",
    inputSchema: obj({ limit: { type: "number" }, sort: { type: "string" } }),
    // ponytail: sort is accepted but always updated_desc — the only order lore asks for.
    handler: (s, a) => s.listPages({ limit: a.limit as number }),
  },
  get_page: {
    access: "read",
    description: "Fetch one page by slug (fuzzy falls back to title match).",
    inputSchema: obj({ slug: { type: "string" }, fuzzy: { type: "boolean" } }, ["slug"]),
    handler: (s, a) => s.getPage({ slug: String(a.slug ?? ""), fuzzy: Boolean(a.fuzzy) }),
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
    handler: (s, a) => s.getBacklinks({ slug: String(a.slug ?? "") }),
  },
  traverse_graph: {
    access: "read",
    description: "Edges reachable from a slug, as {from_slug,to_slug} rows.",
    inputSchema: obj(
      { slug: { type: "string" }, depth: { type: "number" }, direction: { type: "string" } },
      ["slug"],
    ),
    handler: (s, a) =>
      s.traverseGraph({
        slug: String(a.slug ?? ""),
        depth: a.depth as number,
        direction: a.direction as string,
      }),
  },
  sources_list: {
    access: "read",
    description: "The single source of this standalone brain.",
    inputSchema: obj({}),
    handler: async (s) => ({
      sources: [
        {
          id: "default",
          name: process.env.APP_TITLE ?? "brain",
          page_count: await s.pageCount(),
        },
      ],
    }),
  },
  get_recent_salience: {
    access: "read",
    description: "Recently updated pages.",
    inputSchema: obj({ days: { type: "number" }, limit: { type: "number" } }),
    handler: (s, a) => s.recentPages({ days: a.days as number, limit: a.limit as number }),
  },
  put_page: {
    access: "write",
    description:
      "Create or update a page (upsert by slug). Markdown body; [[wikilinks]] become graph edges. " +
      "frontmatter.related_ids (slugs) add explicit edges.",
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
    handler: (s, a) =>
      s.putPage({
        slug: String(a.slug ?? ""),
        title: a.title as string | undefined,
        body: String(a.body ?? ""),
        kind: a.kind as "note" | "memory" | undefined,
        frontmatter: a.frontmatter as Record<string, unknown> | undefined,
      }),
  },
  remember: {
    access: "write",
    description: "Save one atomic memory (auto-slugged mem-<uuid>). Metadata rides as frontmatter.",
    inputSchema: obj({ memory: { type: "string" }, metadata: { type: "object" } }, ["memory"]),
    handler: (s, a) =>
      s.remember({
        memory: String(a.memory ?? ""),
        metadata: a.metadata as Record<string, unknown> | undefined,
      }),
  },
  delete_page: {
    access: "write",
    description: "Soft-delete a page by slug (recoverable in the database).",
    inputSchema: obj({ slug: { type: "string" } }, ["slug"]),
    handler: (s, a) => s.deletePage({ slug: String(a.slug ?? "") }),
  },
};

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
  getStore: () => Promise<Store>,
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
        const store = await getStore();
        const value = await def.handler(store, clampArgs(params?.arguments));
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
