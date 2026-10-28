import type { PostgresDatabase } from "@corespeed/lore-core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, test, vi } from "vitest";
import { createApi } from "@/server/api/app";
import type { ActorContext } from "@/server/auth/actor-context";
import { createAccessModule } from "../support/access";
import { createMemoryTestContext } from "../support/memory-context";

const MCP_URL = "http://lore.local/api/v1/mcp";
const clients: Client[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
});

async function setup() {
  vi.stubEnv("AUTH_MODE", "password");
  vi.stubEnv("UI_PASSWORD", "test-password");
  const context = await createMemoryTestContext();
  const access = createAccessModule(context.database);
  const app = requestScopedHost(context.database);
  async function agentFor(actor: ActorContext) {
    const agent = await access.createAgentForWorkspace(actor, {
      name: "MCP over HTTP",
      permission: "write",
    });
    const credential = await access.issueAgentCredential(actor, agent.id);
    return { agent, headers: agentHeaders(credential.token, actor.workspaceId) };
  }
  return { context, access, app, agentFor };
}

type Host = ReturnType<typeof requestScopedHost>;

/**
 * Like fetchCloudflareApi: each request gets its own API and database handle, and
 * the handle closes once the response returns, so work that outlives it fails.
 */
function requestScopedHost(database: PostgresDatabase) {
  return {
    async request(input: string | Request, init?: RequestInit): Promise<Response> {
      let open = true;
      const app = createApi({
        database: (): PostgresDatabase => ({
          transaction(use, options) {
            if (!open) throw new Error("The request's database is closed");
            return database.transaction(use, options);
          },
        }),
        memoryOptions: () => ({}),
        codeRepositories: () => ({}),
      });
      try {
        return await app.request(input, init);
      } finally {
        open = false;
      }
    },
  };
}

function agentHeaders(token: string, workspaceId: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "x-lore-workspace-id": workspaceId };
}

async function connect(app: Host, headers: Record<string, string>) {
  const client = new Client({ name: "lore-http-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers },
      fetch: async (input, init) => app.request(new Request(input, init)),
    }),
  );
  clients.push(client);
  return client;
}

async function withContext(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const fixture = await setup();
  try {
    await run(fixture);
  } finally {
    await fixture.context.close();
  }
}

test("an Agent uses the Lore tools over Streamable HTTP, scoped by RLS", async () => {
  await withContext(async ({ app, agentFor, context }) => {
    const alice = await agentFor(context.alice);
    const client = await connect(app, alice.headers);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["lore_remember", "lore_search", "lore_get"]),
    );

    const remembered = await client.callTool({
      name: "lore_remember",
      arguments: { content: "Alice keeps the deploy runbook private.", scope: "private" },
    });
    expect(remembered.isError).toBeFalsy();
    const memory = (remembered.structuredContent as { memory: { id: string } }).memory;
    const read = await client.callTool({ name: "lore_get", arguments: { memoryId: memory.id } });
    expect(read.structuredContent).toMatchObject({ memory: { id: memory.id, scope: "private" } });
    // The tool call wrote as the Agent that the MCP request named.
    const stored = await app.request(`/api/v1/memories/${memory.id}`, { headers: alice.headers });
    expect(await stored.json()).toMatchObject({ createdByAgentId: alice.agent.id });

    // Bob shares the Workspace, but Alice's private Memory stays invisible to his Agent.
    const bob = await connect(app, (await agentFor(context.bob)).headers);
    const hidden = await bob.callTool({ name: "lore_get", arguments: { memoryId: memory.id } });
    expect(hidden.isError).toBe(true);
    const listed = await bob.callTool({ name: "lore_list", arguments: {} });
    expect(listed.structuredContent).toMatchObject({ memories: [] });
  });
});

test("the endpoint refuses a request without a usable Agent credential before MCP starts", async () => {
  await withContext(async ({ app, access, agentFor, context }) => {
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "lore-http-test", version: "1.0.0" },
      },
    });
    const post = (headers: Record<string, string>) =>
      app.request(MCP_URL, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...headers,
        },
        body: initialize,
      });

    expect((await post({})).status).toBe(401);
    const unknownToken = agentHeaders(`lore_agent_${"0".repeat(64)}`, context.alice.workspaceId);
    expect((await post(unknownToken)).status).toBe(403);

    const { agent, headers } = await agentFor(context.alice);
    expect((await post(headers)).status).toBe(200);
    // Carol's Workspace grants Alice's Agent nothing.
    const foreign = { ...headers, "x-lore-workspace-id": context.carol.workspaceId };
    expect((await post(foreign)).status).toBe(403);
    await access.revokeAgentGrant(context.alice, agent.id);
    expect((await post(headers)).status).toBe(403);

    // A human may use the API in their own Workspace, but MCP tools act only as an Agent.
    const basic = { authorization: `Basic ${btoa("lore:test-password")}` };
    const created = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { ...basic, "content-type": "application/json" },
      body: JSON.stringify({ name: "Operator" }),
    });
    const workspace = (await created.json()) as { id: string };
    const human = await post({ ...basic, "x-lore-workspace-id": workspace.id });
    expect(human.status).toBe(401);
    expect(await human.json()).toEqual({
      code: "authentication_required",
      error: "Lore MCP requires an Agent token",
    });
  });
});

test("a 2025-era tool call answers in JSON once the tool has finished", async () => {
  await withContext(async ({ app, agentFor, context }) => {
    const { headers } = await agentFor(context.alice);
    const response = await app.request(MCP_URL, {
      method: "POST",
      headers: {
        ...headers,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "lore_remember",
          arguments: { content: "Legacy clients get a whole answer." },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const answer = (await response.json()) as {
      id: number;
      result: { isError?: boolean; structuredContent: { memory: { id: string } } };
    };
    expect(answer.id).toBe(7);
    expect(answer.result.isError).toBeFalsy();
    const stored = await app.request(
      `/api/v1/memories/${answer.result.structuredContent.memory.id}`,
      { headers },
    );
    expect(stored.status).toBe(200);
  });
});
