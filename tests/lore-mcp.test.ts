import {
  createLoreMcpServer,
  type LoreMcpCodeClient,
  type LoreMcpContextClient,
  type LoreMcpMemoryClient,
} from "@corespeed/lore-mcp";
import type {
  CodeArtifact,
  CodeDependencyQueryResult,
  Episode,
  Memory,
  MemoryProposal,
} from "@corespeed/lore-sdk";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test, vi } from "vitest";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const MEMORY_ID = "20000000-0000-4000-8000-000000000001";
const EPISODE_ID = "60000000-0000-4000-8000-000000000001";

function episode(): Episode {
  return {
    id: EPISODE_ID,
    workspaceId: WORKSPACE_ID,
    ownerUserId: "30000000-0000-4000-8000-000000000001",
    recordedByActorKind: "agent",
    recordedByAgentId: "40000000-0000-4000-8000-000000000001",
    kind: "conversation",
    scope: "private",
    startedAt: "2026-08-10T00:00:00.000Z",
    endedAt: "2026-08-10T00:00:00.000Z",
    observationCount: 1,
    createdAt: "2026-08-10T00:00:01.000Z",
    observations: [
      {
        id: "70000000-0000-4000-8000-000000000001",
        workspaceId: WORKSPACE_ID,
        episodeId: EPISODE_ID,
        ordinal: 0,
        kind: "message",
        observedAt: "2026-08-10T00:00:00.000Z",
        payloadSha256: "a".repeat(64),
        content: "Private raw observation",
        metadata: { role: "user" },
        createdAt: "2026-08-10T00:00:01.000Z",
      },
    ],
  };
}

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
    evidenceObservationIds: [],
    codeEvidence: [],
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
    recordEpisode: vi.fn().mockResolvedValue(episode()),
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

function fakeCode(): LoreMcpCodeClient {
  const artifact: CodeArtifact = {
    id: "80000000-0000-4000-8000-000000000001",
    repositoryId: "80000000-0000-4000-8000-000000000002",
    revisionId: "80000000-0000-4000-8000-000000000003",
    generationId: "80000000-0000-4000-8000-000000000004",
    commitOid: "a".repeat(40),
    path: "src/guard.ts",
    language: "typescript",
    parser: "tree_sitter",
    parseStatus: "parsed",
    kind: "function_declaration",
    symbol: "guard",
    symbolKey: "src/guard.ts#function_declaration:guard",
    declarationKey: "src/guard.ts#function_declaration:guard",
    declarationChunkOrdinal: 0,
    symbols: [],
    ordinal: 0,
    startLine: 1,
    endLine: 1,
    content: "export function guard() { return true; }",
    contentSha256: "b".repeat(64),
    matchedChannels: ["symbol", "lexical"],
    score: 0.1,
  };
  const dependencies: CodeDependencyQueryResult = {
    status: "ok",
    repositoryKey: "corespeed/lore",
    commitOid: artifact.commitOid,
    direction: "callees",
    subject: {
      artifactId: artifact.id,
      path: artifact.path,
      symbol: artifact.symbol,
      symbolKey: artifact.symbolKey,
    },
    edges: [],
    truncated: false,
  };
  return {
    searchCode: vi.fn().mockResolvedValue([artifact]),
    queryCodeDependencies: vi.fn().mockResolvedValue(dependencies),
    enqueueCodeIndex: vi.fn().mockResolvedValue({
      id: "90000000-0000-4000-8000-000000000001",
      repositoryId: artifact.repositoryId,
      repositoryKey: "corespeed/lore",
      commitOid: artifact.commitOid,
      sourceRef: null,
      indexerRevision: "test",
      status: "pending",
      attemptCount: 0,
      maximumAttempts: 5,
      availableAt: "2026-08-12T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    }),
    getCodeIndexJob: vi.fn(),
    listMemoryCodeEvidence: vi.fn().mockResolvedValue([]),
    citeMemoryCodeEvidence: vi.fn(),
    revalidateMemoryCodeEvidence: vi.fn(),
  };
}

function fakeContext(): LoreMcpContextClient {
  return {
    retrieveContext: vi.fn().mockResolvedValue({
      revision: "joint-memory-code-v2",
      query: "authorized",
      plan: {
        intent: "unknown",
        route: "memory-only",
        needsAnchorExpansion: false,
        needsContextualImpact: false,
        needsLocalAssessment: false,
        reasons: ["explicit route"],
      },
      deliveredRoute: "memory-only",
      memories: [],
      code: [],
      anchors: [],
      conflicts: [],
      receipt: {
        memoryCandidates: 0,
        codeCandidates: 0,
        anchorCandidates: 0,
        requestedCommitOid: null,
        memoryQuery: "authorized",
        codeQuery: null,
        contextualImpact: null,
      },
    }),
  };
}

const connected: Array<{ client: Client; server: ReturnType<typeof createLoreMcpServer> }> = [];

afterEach(async () => {
  await Promise.allSettled(
    connected.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]),
  );
});

async function connect(
  memories: LoreMcpMemoryClient,
  code: LoreMcpCodeClient = fakeCode(),
  context: LoreMcpContextClient = fakeContext(),
) {
  const server = createLoreMcpServer({ memories, code, context });
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
      "lore_observe",
      "lore_propose",
      "lore_update",
      "lore_forget",
      "lore_retrieve_context",
      "lore_code_search",
      "lore_code_dependencies",
      "lore_code_index",
      "lore_code_index_status",
      "lore_code_evidence_list",
      "lore_code_evidence_cite",
      "lore_code_evidence_revalidate",
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

  test("retrieves bounded Memory and exact-revision Code context through one read-only tool", async () => {
    const code = fakeCode();
    const context = fakeContext();
    vi.mocked(context.retrieveContext).mockResolvedValue({
      revision: "joint-memory-code-v2",
      query: "Why did the guard change?",
      plan: {
        intent: "change",
        route: "both",
        needsAnchorExpansion: true,
        needsContextualImpact: true,
        needsLocalAssessment: true,
        reasons: ["change questions require historical claims and current evidence"],
      },
      deliveredRoute: "both",
      memories: [
        {
          id: MEMORY_ID,
          scope: "private",
          updatedAt: memory().updatedAt,
          score: 0.9,
          evidence: "The guard was introduced for tenant isolation.",
        },
      ],
      code: [
        {
          artifactId: "80000000-0000-4000-8000-000000000001",
          commitOid: "a".repeat(40),
          path: "src/guard.ts",
          symbol: "guard",
          startLine: 1,
          endLine: 1,
          score: 0.1,
          matchedChannels: ["symbol", "lexical"],
          content: "export function guard() { return true; }",
        },
      ],
      anchors: [
        {
          id: "81000000-0000-4000-8000-000000000001",
          memoryId: MEMORY_ID,
          relationship: "rationale",
          localState: "changed",
          citedCommitOid: "b".repeat(40),
          citedPath: "src/guard.ts",
          validatedCommitOid: "a".repeat(40),
          validatedPath: "src/guard.ts",
        },
      ],
      conflicts: ["anchor:81000000-0000-4000-8000-000000000001:changed"],
      receipt: {
        memoryCandidates: 1,
        codeCandidates: 1,
        anchorCandidates: 1,
        requestedCommitOid: "a".repeat(40),
        memoryQuery: "guard decision",
        codeQuery: "guard",
        contextualImpact: null,
      },
    });
    const client = await connect(fakeMemories(), code, context);

    const result = await client.callTool({
      name: "lore_retrieve_context",
      arguments: {
        query: "Why did the guard change?",
        memoryQuery: "guard decision",
        codeQuery: "guard",
        repositoryKey: "corespeed/lore",
        commitOid: "a".repeat(40),
        memoryLimit: 4,
        codeLimit: 6,
      },
    });

    expect(context.retrieveContext).toHaveBeenCalledWith({
      query: "Why did the guard change?",
      memoryQuery: "guard decision",
      codeQuery: "guard",
      repositoryKey: "corespeed/lore",
      commitOid: "a".repeat(40),
      memoryLimit: 4,
      codeLimit: 6,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      deliveredRoute: "both",
      memories: [{ id: MEMORY_ID, evidence: "The guard was introduced for tenant isolation." }],
      code: [{ path: "src/guard.ts", symbol: "guard" }],
      anchors: [{ localState: "changed", validatedCommitOid: "a".repeat(40) }],
    });
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "lore_retrieve_context");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tool?.description).toContain("Use this tool before answering");
    expect(tool?.description).toContain("prior Workspace decisions");
    expect(tool?.description).toContain("Do not use it");
    expect(tool?.description).toContain("full commit OID");
    expect(JSON.stringify(tool?.inputSchema)).not.toContain("workspaceId");
    expect(JSON.stringify(tool?.inputSchema)).not.toContain("repositoryPath");

    const missingRevision = await client.callTool({
      name: "lore_retrieve_context",
      arguments: {
        query: "Why did the guard change?",
        repositoryKey: "corespeed/lore",
      },
    });
    expect(missingRevision.isError).toBe(true);
    expect(context.retrieveContext).toHaveBeenCalledTimes(1);
  });

  test("keeps Code Index tools separate from Memory and omits filesystem and Workspace input", async () => {
    const code = fakeCode();
    const client = await connect(fakeMemories(), code);
    const result = await client.callTool({
      name: "lore_code_search",
      arguments: {
        repositoryKey: "corespeed/lore",
        commitOid: "a".repeat(40),
        query: "guard",
        limit: 5,
      },
    });

    expect(code.searchCode).toHaveBeenCalledWith({
      repositoryKey: "corespeed/lore",
      commitOid: "a".repeat(40),
      query: "guard",
      limit: 5,
    });
    expect(result.structuredContent).toMatchObject({
      artifacts: [{ path: "src/guard.ts", matchedChannels: ["symbol", "lexical"] }],
    });
    const dependencies = await client.callTool({
      name: "lore_code_dependencies",
      arguments: {
        repositoryKey: "corespeed/lore",
        commitOid: "a".repeat(40),
        direction: "callees",
        symbol: "guard",
        limit: 25,
      },
    });
    expect(code.queryCodeDependencies).toHaveBeenCalledWith({
      repositoryKey: "corespeed/lore",
      commitOid: "a".repeat(40),
      direction: "callees",
      symbol: "guard",
      limit: 25,
    });
    expect(dependencies.structuredContent).toMatchObject({
      status: "ok",
      subject: { path: "src/guard.ts", symbol: "guard" },
      edges: [],
      truncated: false,
    });
    const queued = await client.callTool({
      name: "lore_code_index",
      arguments: {
        repositoryKey: "corespeed/lore",
        commitOid: "a".repeat(40),
      },
    });
    expect(code.enqueueCodeIndex).toHaveBeenCalledWith({
      repositoryKey: "corespeed/lore",
      commitOid: "a".repeat(40),
    });
    expect(queued.structuredContent).toMatchObject({ job: { status: "pending" } });
    const { tools } = await client.listTools();
    for (const tool of tools.filter((tool) => tool.name.startsWith("lore_code"))) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain("workspaceId");
      expect(JSON.stringify(tool.inputSchema)).not.toContain("repositoryPath");
    }
  });

  test("submits a bounded non-canonical proposal with replay protection", async () => {
    const memories = fakeMemories();
    const client = await connect(memories);
    const artifactId = "80000000-0000-4000-8000-000000000001";
    const codeEvidence = {
      ordinal: 0,
      repositoryId: "80000000-0000-4000-8000-000000000002",
      citedRevisionId: "80000000-0000-4000-8000-000000000003",
      citedGenerationId: "80000000-0000-4000-8000-000000000004",
      citedArtifactId: artifactId,
      citedCommitOid: "a".repeat(40),
      citedPath: "src/guard.ts",
      citedSymbolKey: "src/guard.ts#function_declaration:guard",
      citedDeclarationKey: "src/guard.ts#function_declaration:guard",
      citedDeclarationChunkOrdinal: 0,
      citedDeclarationContextSha256: "c".repeat(64),
      citedContentSha256: "b".repeat(64),
      relationship: "implements" as const,
    };
    vi.mocked(memories.proposeMemory).mockResolvedValue(proposal({ codeEvidence: [codeEvidence] }));

    const result = await client.callTool({
      name: "lore_propose",
      arguments: {
        kind: "create",
        content: "Proposed fact",
        scope: "private",
        codeEvidence: [{ artifactId, relationship: "implements" }],
        idempotencyKey: "proposal-1",
      },
    });

    expect(memories.proposeMemory).toHaveBeenCalledWith(
      {
        kind: "create",
        content: "Proposed fact",
        scope: "private",
        codeEvidence: [{ artifactId, relationship: "implements" }],
      },
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
        evidenceObservationIds: [],
        codeEvidence: [codeEvidence],
        status: "pending",
        createdAt: proposal().createdAt,
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("Proposed fact");
  });

  test("rejects document-sized Memory content before calling Lore", async () => {
    const memories = fakeMemories();
    const client = await connect(memories);

    const result = await client.callTool({
      name: "lore_remember",
      arguments: { content: "x".repeat(32_001) },
    });

    expect(result.isError).toBe(true);
    expect(memories.remember).not.toHaveBeenCalled();
  });

  test("records bounded Observation evidence without returning raw payload content", async () => {
    const memories = fakeMemories();
    const client = await connect(memories);
    const rawContent = "  Private raw observation\n";

    const result = await client.callTool({
      name: "lore_observe",
      arguments: {
        kind: "conversation",
        observations: [{ kind: "message", content: rawContent }],
        idempotencyKey: "observe-1",
      },
    });

    expect(memories.recordEpisode).toHaveBeenCalledWith(
      {
        kind: "conversation",
        scope: "private",
        observations: [{ kind: "message", content: rawContent }],
      },
      { idempotencyKey: "observe-1" },
    );
    expect(result.structuredContent).toMatchObject({
      episode: {
        id: EPISODE_ID,
        observations: [{ id: episode().observations[0].id, payloadSha256: "a".repeat(64) }],
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("Private raw observation");
    expect(JSON.stringify(result.structuredContent)).not.toContain(WORKSPACE_ID);
  });

  test("rejects an Episode whose aggregate metadata exceeds the tool budget", async () => {
    const memories = fakeMemories();
    const client = await connect(memories);

    const result = await client.callTool({
      name: "lore_observe",
      arguments: {
        kind: "event",
        observations: Array.from({ length: 11 }, () => ({
          kind: "event",
          content: "Bound metadata.",
          metadata: { payload: "m".repeat(99_000) },
        })),
      },
    });

    expect(result.isError).toBe(true);
    expect(memories.recordEpisode).not.toHaveBeenCalled();
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
