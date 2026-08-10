import { createLoreMcpServer, type LoreMcpMemoryClient } from "@corespeed/lore-mcp";
import type { Memory, MemoryProposal } from "@corespeed/lore-sdk";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test, vi } from "vitest";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const MEMORY_ID = "20000000-0000-4000-8000-000000000001";

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: MEMORY_ID,
    workspaceId: WORKSPACE_ID,
    ownerUserId: "30000000-0000-4000-8000-000000000001",
    createdByAgentId: "40000000-0000-4000-8000-000000000001",
    scope: "private",
    content: "Only authorized content",
    metadata: { source: "test" },
    version: 2,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: "50000000-0000-4000-8000-000000000001",
    workspaceId: WORKSPACE_ID,
    ownerUserId: "30000000-0000-4000-8000-000000000001",
    proposedByActorKind: "agent",
    proposedByAgentId: "40000000-0000-4000-8000-000000000001",
    kind: "create",
    targetMemoryId: null,
    baseMemoryVersion: null,
    proposedContent: "Proposed fact",
    proposedScope: "private",
    proposedMetadata: {},
    evidenceMemoryIds: [],
    status: "pending",
    reviewedByUserId: null,
    acceptedMemoryId: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    reviewedAt: null,
    ...overrides,
  };
}

function fakeMemories(): LoreMcpMemoryClient {
  return {
    forgetMemory: vi.fn().mockResolvedValue(undefined),
    getMemory: vi.fn().mockResolvedValue(memory()),
    listMemories: vi.fn().mockResolvedValue({ memories: [memory()], nextCursor: null }),
    proposeMemory: vi.fn().mockResolvedValue(proposal()),
    remember: vi.fn().mockResolvedValue(memory({ version: 1 })),
    searchMemories: vi
      .fn()
      .mockResolvedValue([
        { memory: memory(), score: 0.9, rerankScore: 0.8, evidence: "authorized evidence" },
      ]),
    updateMemory: vi.fn().mockResolvedValue(memory({ version: 3 })),
  };
}

const connected: Array<{ client: Client; server: ReturnType<typeof createLoreMcpServer> }> = [];

afterEach(async () => {
  await Promise.allSettled(
    connected.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]),
  );
});

async function connect(memories: LoreMcpMemoryClient) {
  const server = createLoreMcpServer({ memories });
  const client = new Client({ name: "lore-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  connected.push({ client, server });
  return client;
}

describe("Lore external MCP adapter", () => {
  test("advertises bounded read and mutation tools with destructive metadata", async () => {
    const client = await connect(fakeMemories());
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "lore_list",
      "lore_search",
      "lore_get",
      "lore_remember",
      "lore_propose",
      "lore_update",
      "lore_forget",
    ]);
    expect(tools.find((tool) => tool.name === "lore_search")?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(tools.find((tool) => tool.name === "lore_forget")?.annotations).toMatchObject({
      destructiveHint: true,
    });
    expect(tools.find((tool) => tool.name === "lore_update")?.annotations).toMatchObject({
      destructiveHint: true,
    });
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain("workspaceId");
    }
  });

  test("submits a bounded non-canonical proposal with replay protection", async () => {
    const memories = fakeMemories();
    const client = await connect(memories);

    const result = await client.callTool({
      name: "lore_propose",
      arguments: {
        kind: "create",
        content: "Proposed fact",
        scope: "private",
        idempotencyKey: "proposal-1",
      },
    });

    expect(memories.proposeMemory).toHaveBeenCalledWith(
      { kind: "create", content: "Proposed fact", scope: "private" },
      { idempotencyKey: "proposal-1" },
    );
    expect(result.structuredContent).toEqual({
      proposal: {
        id: proposal().id,
        kind: "create",
        targetMemoryId: null,
        baseMemoryVersion: null,
        proposedScope: "private",
        evidenceMemoryIds: [],
        status: "pending",
        createdAt: proposal().createdAt,
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("Proposed fact");
  });

  test("calls Lore through the injected deep client and removes tenant identity fields", async () => {
    const memories = fakeMemories();
    const client = await connect(memories);

    const result = await client.callTool({
      name: "lore_search",
      arguments: { query: "authorized", limit: 5 },
    });

    expect(memories.searchMemories).toHaveBeenCalledWith({ query: "authorized", limit: 5 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      results: [{ memory: { id: MEMORY_ID }, evidence: "authorized evidence" }],
    });
    expect(result.structuredContent).not.toHaveProperty("results.0.memory.content");
    expect(JSON.stringify(result.structuredContent)).not.toContain(WORKSPACE_ID);
    expect(JSON.stringify(result.structuredContent)).not.toContain("ownerUserId");
    expect(JSON.stringify(result.structuredContent)).not.toContain("createdByAgentId");
  });

  test("forwards optimistic concurrency and marks a successful forget", async () => {
    const memories = fakeMemories();
    const client = await connect(memories);

    const result = await client.callTool({
      name: "lore_forget",
      arguments: { memoryId: MEMORY_ID, version: 2, idempotencyKey: "forget-1" },
    });

    expect(memories.forgetMemory).toHaveBeenCalledWith(MEMORY_ID, {
      expectedVersion: 2,
      idempotencyKey: "forget-1",
    });
    expect(result.structuredContent).toEqual({ deleted: true });
  });

  test("does not reflect unexpected internal failures to the MCP client", async () => {
    const memories = fakeMemories();
    vi.mocked(memories.getMemory).mockRejectedValueOnce(
      new Error("internal detail containing lore_agent_secret"),
    );
    const client = await connect(memories);

    const result = await client.callTool({
      name: "lore_get",
      arguments: { memoryId: MEMORY_ID },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Lore request failed");
    expect(JSON.stringify(result.content)).not.toContain("lore_agent_secret");
  });

  test("bounds list and search output without duplicating full Memory content", async () => {
    const memories = fakeMemories();
    const largeMemory = memory({
      content: "private-memory-".repeat(70_000),
      metadata: { privateMetadata: "m".repeat(5_000) },
    });
    vi.mocked(memories.listMemories).mockResolvedValueOnce({
      memories: Array.from({ length: 25 }, () => largeMemory),
      nextCursor: null,
    });
    vi.mocked(memories.searchMemories).mockResolvedValueOnce(
      Array.from({ length: 25 }, () => ({
        memory: largeMemory,
        score: 0.9,
        evidence: "authorized-evidence-".repeat(1_000),
      })),
    );
    const client = await connect(memories);

    const listed = await client.callTool({ name: "lore_list", arguments: { limit: 25 } });
    const searched = await client.callTool({
      name: "lore_search",
      arguments: { query: "authorized", limit: 25 },
    });

    expect(JSON.stringify(listed.structuredContent).length).toBeLessThanOrEqual(128_000);
    expect(listed.structuredContent).toHaveProperty("memories.0.contentTruncated", true);
    expect(listed.structuredContent).toHaveProperty("memories.0.metadataTruncated", true);
    expect(JSON.stringify(searched.structuredContent).length).toBeLessThanOrEqual(128_000);
    expect(searched.structuredContent).toHaveProperty("results.0.evidenceTruncated", true);
    expect(searched.structuredContent).toHaveProperty("results.0.memory.metadataTruncated", true);
    expect(JSON.stringify(searched.structuredContent)).not.toContain("private-memory-");
    expect(JSON.stringify(searched.content)).not.toContain("authorized-evidence-");
  });

  test("rejects metadata beyond the Portable Core depth boundary", async () => {
    const client = await connect(fakeMemories());
    let metadata: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 34; depth += 1) metadata = { child: metadata };

    const result = await client.callTool({
      name: "lore_remember",
      arguments: { content: "bounded", metadata },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("metadata exceeds 32 levels");
  });
});
