// The viewer's door to the brain. One page, one job: the console asks for a
// tool by name and gets its payload back.
//
// This used to be `gbrain.ts` — an OAuth2 client_credentials minter, a token
// cache, an SSE-or-JSON response parser, a proxy to an external MCP server, and
// a hand-maintained list of the tools that server was believed to have. lore
// serves its own brain now, so all of that went, and the list went with it: 13
// of its 28 entries named tools that exist nowhere in this repo, which is what a
// second copy of a registry always becomes.
//
// Compiler-enforced server-only: the console reaches this through /api/call, and
// importing it from a Client Component is a build error.
import "server-only";

export class ToolNotAllowedError extends Error {}

// Two doors, one decision. `handleRpc` refuses a write tool to a "read" caller
// by reading the tool's OWN `access`, and this door hands it "read" — so the
// console cannot reach a write tool no matter what it asks for, and there is no
// second list to drift out of step with the first.
export async function callTool(
  tool: string,
  args: object,
): Promise<{ isError: boolean; text: string }> {
  const { TOOLS } = await import("@/server/mcp");
  // Refused HERE so /api/call can answer 403 and say why. The dispatcher would
  // refuse it too — that is the boundary, and it stays the boundary — but it
  // throws a plain Error, which the route reports as 502 "brain error": a
  // caller naming a write tool was told the brain was broken. Read off the same
  // registry the dispatcher reads, so this cannot become a second list.
  if (!Object.hasOwn(TOOLS, tool) || TOOLS[tool].access !== "read") {
    throw new ToolNotAllowedError(`tool '${tool}' not allowed (read-only)`);
  }
  const { callLocalTool } = await import("@/server/local");
  return callLocalTool(tool, args);
}

// What a viewer session may call, derived from the registry rather than
// restated. Async because the registry lives behind the server-only boundary
// that keeps `pg` out of bundles which never open a database.
export async function readToolNames(): Promise<readonly string[]> {
  const { READ_TOOL_NAMES } = await import("@/server/mcp");
  return READ_TOOL_NAMES;
}
