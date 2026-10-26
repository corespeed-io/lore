import { createLoreMcpHttpHandler } from "@corespeed/lore-mcp";
import { Hono } from "hono";
import type { ApiEnv } from "./dependencies";

/**
 * Streamable HTTP MCP. The tools call this API in process through the SDK, so each
 * tool call is admitted, authorized, and scoped like any other Agent request.
 */
export function mcp(api: Pick<Hono<ApiEnv>, "fetch">) {
  const handle = createLoreMcpHttpHandler({
    fetch: async (input, init) => api.fetch(new Request(input, init)),
    // The requests never leave the process, whatever scheme the inbound URL has.
    allowInsecure: true,
  });
  return new Hono<ApiEnv>().post("/", async (c) => {
    // Refuse a bad Agent token or Workspace with the API's own status before MCP starts.
    await c.get("resolveActor")();
    return handle(c.req.raw);
  });
}
