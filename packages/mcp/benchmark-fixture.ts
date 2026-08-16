import { appendFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createRetrievalPolicyMcpHarness } from "../../scripts/lib/retrieval-policy-mcp";

const selectedTools = new Set(
  (process.env.LORE_RETRIEVAL_POLICY_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);
const tracePath = process.env.LORE_RETRIEVAL_POLICY_TRACE_PATH?.trim() || null;
const harness = await createRetrievalPolicyMcpHarness();
const proxy = new Server(
  { name: "lore-retrieval-policy-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

proxy.setRequestHandler("tools/list", async () => ({
  tools: await harness.listTools(selectedTools.size > 0 ? [...selectedTools] : undefined),
}));
proxy.setRequestHandler("tools/call", async (request) => {
  const startedAt = performance.now();
  const result = await harness.callTool({
    name: request.params.name,
    arguments: request.params.arguments,
  });
  if (tracePath) {
    await appendFile(
      tracePath,
      `${JSON.stringify({
        name: request.params.name,
        arguments: request.params.arguments ?? {},
        result: result.structuredContent ?? null,
        latencyMs: performance.now() - startedAt,
      })}\n`,
      "utf8",
    );
  }
  return result;
});

const transport = new StdioServerTransport();
await proxy.connect(transport);

async function close(): Promise<void> {
  await Promise.allSettled([proxy.close(), harness.close()]);
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
