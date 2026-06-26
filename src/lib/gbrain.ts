// Compiler-enforced: this module reads GBRAIN_TOKEN and must never reach the
// client bundle. Importing it from a Client Component is a build error.
import "server-only";
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

// Cached OAuth2 access token (client_credentials). gbrain access tokens are
// short-lived (~1h), so mint on demand and refresh ~1min before expiry.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function bearerToken(cfg: ReturnType<typeof loadConfig>): Promise<string> {
  // No OAuth client configured → fall back to the static bearer (GBRAIN_TOKEN).
  if (!cfg.gbrainClientId || !cfg.gbrainClientSecret) return cfg.gbrainToken;
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.value;
  const tokenUrl = cfg.gbrainTokenUrl || new URL("/token", cfg.gbrainMcpUrl).toString();
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.gbrainClientId,
      client_secret: cfg.gbrainClientSecret,
    }),
  });
  if (!res.ok) throw new Error(`gbrain token ${res.status}`);
  const tok = (await res.json()) as { access_token: string; expires_in?: number };
  cachedToken = { value: tok.access_token, expiresAt: now + (tok.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
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
      Authorization: `Bearer ${await bearerToken(cfg)}`,
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
