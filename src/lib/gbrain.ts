import { loadConfig } from "./config";

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "get_brain_identity",
  "list_pages",
  "get_page",
  "search",
  "query",
  "recall",
  "get_timeline",
  "get_backlinks",
  "get_links",
  "get_tags",
  "traverse_graph",
  "get_recent_salience",
  "get_ingest_log",
  "sources_list",
  "code_def",
  "code_refs",
  "code_callers",
  "code_callees",
  "find_experts",
  "list_link_sources",
  "resolve_slugs",
  "get_chunks",
]);

export class ToolNotAllowedError extends Error {}

export function parseMcp(body: string): unknown {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("data:")) return JSON.parse(line.slice("data:".length).trim());
  }
  return JSON.parse(body);
}

export async function callTool(
  tool: string,
  args: object,
): Promise<{ isError: boolean; text: string }> {
  if (!READ_ONLY_TOOLS.has(tool))
    throw new ToolNotAllowedError(`tool '${tool}' not allowed (read-only)`);
  const cfg = loadConfig();
  const res = await fetch(cfg.gbrainMcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.gbrainToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  if (!res.ok) throw new Error(`gbrain ${res.status}`);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic RPC response
  const rpc = parseMcp(await res.text()) as any;
  if (rpc?.error)
    throw new Error(typeof rpc.error === "string" ? rpc.error : JSON.stringify(rpc.error));
  const result = rpc?.result ?? {};
  const content = result.content ?? [];
  const text = content[0]?.text ?? "";
  return { isError: Boolean(result.isError), text };
}
