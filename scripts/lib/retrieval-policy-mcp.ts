import {
  createLoreMcpServer,
  type LoreMcpCodeClient,
  type LoreMcpContextClient,
  type LoreMcpMemoryClient,
} from "@corespeed/lore-mcp";
import type {
  CodeArtifact,
  CodeDependencyQueryResult,
  Memory,
  RetrieveContextInput,
  RetrievedContext,
} from "@corespeed/lore-sdk";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { planJointEvidenceRoute } from "../../src/lib/joint-memory-code";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const MEMORY_ID = "30000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = "40000000-0000-4000-8000-000000000001";
const REVISION_ID = "50000000-0000-4000-8000-000000000001";
const GENERATION_ID = "60000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = "70000000-0000-4000-8000-000000000001";
const NOW = "2026-08-15T00:00:00.000Z";

function unavailable(): never {
  throw new Error("This mutation is unavailable in the retrieval-policy benchmark fixture");
}

function fixtureMemory(): Memory {
  return {
    id: MEMORY_ID,
    workspaceId: WORKSPACE_ID,
    ownerUserId: USER_ID,
    createdByAgentId: null,
    scope: "shared",
    content:
      "The team decided that proposal review must remain human-only before canonical Memory changes.",
    metadata: { fixture: "retrieval-policy-v1" },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fixtureArtifact(commitOid: string): CodeArtifact {
  return {
    id: ARTIFACT_ID,
    repositoryId: REPOSITORY_ID,
    revisionId: REVISION_ID,
    generationId: GENERATION_ID,
    commitOid,
    path: "src/lib/memory.ts",
    language: "typescript",
    parser: "tree_sitter",
    parseStatus: "parsed",
    kind: "function_declaration",
    symbol: "submitMemoryProposal",
    symbolKey: "src/lib/memory.ts#function_declaration:submitMemoryProposal",
    declarationKey: "src/lib/memory.ts#function_declaration:submitMemoryProposal",
    declarationChunkOrdinal: 0,
    symbols: [],
    ordinal: 0,
    startLine: 100,
    endLine: 112,
    content: "export async function submitMemoryProposal() { return reviewRequired(); }",
    contentSha256: "b".repeat(64),
    matchedChannels: ["symbol", "lexical"],
    score: 0.95,
  };
}

function fixtureMemories(): LoreMcpMemoryClient {
  const memory = fixtureMemory();
  return {
    recordEpisode: async () => unavailable(),
    forgetMemory: async () => unavailable(),
    getMemory: async () => memory,
    listMemories: async () => ({ memories: [memory], nextCursor: null }),
    proposeMemory: async () => unavailable(),
    remember: async () => unavailable(),
    searchMemories: async () => [
      {
        memory,
        score: 0.95,
        evidence: "Proposal review must remain human-only before canonical Memory changes.",
      },
    ],
    updateMemory: async () => unavailable(),
  };
}

function fixtureCode(): LoreMcpCodeClient {
  return {
    searchCode: async (input) => [fixtureArtifact(input.commitOid)],
    queryCodeDependencies: async (input): Promise<CodeDependencyQueryResult> => ({
      status: "ok",
      repositoryKey: input.repositoryKey,
      commitOid: input.commitOid,
      direction: input.direction,
      subject: {
        artifactId: ARTIFACT_ID,
        path: "src/lib/memory.ts",
        symbol: "submitMemoryProposal",
        symbolKey: "src/lib/memory.ts#function_declaration:submitMemoryProposal",
      },
      edges: [],
      truncated: false,
    }),
    enqueueCodeIndex: async () => unavailable(),
    getCodeIndexJob: async () => unavailable(),
    listMemoryCodeEvidence: async () => [],
    citeMemoryCodeEvidence: async () => unavailable(),
    revalidateMemoryCodeEvidence: async () => unavailable(),
  };
}

function retrievedContext(input: RetrieveContextInput): RetrievedContext {
  const repositoryContext = input.repositoryKey !== undefined && input.commitOid !== undefined;
  const plan = planJointEvidenceRoute({
    query: input.query,
    route: input.route,
    hasRepositoryContext: repositoryContext,
  });
  const includeMemory = plan.route === "memory-only" || plan.route === "both";
  const includeCode = plan.route === "code-only" || plan.route === "both";
  const memory = fixtureMemory();
  const artifact = input.commitOid ? fixtureArtifact(input.commitOid) : null;
  return {
    revision: "joint-memory-code-v2",
    query: input.query,
    plan,
    deliveredRoute: plan.route,
    memories: includeMemory
      ? [
          {
            id: memory.id,
            scope: memory.scope,
            score: 0.95,
            evidence: "Proposal review must remain human-only before canonical Memory changes.",
            updatedAt: memory.updatedAt,
          },
        ]
      : [],
    code:
      includeCode && artifact
        ? [
            {
              artifactId: artifact.id,
              commitOid: artifact.commitOid,
              path: artifact.path,
              symbol: artifact.symbol,
              startLine: artifact.startLine,
              endLine: artifact.endLine,
              content: artifact.content,
              matchedChannels: artifact.matchedChannels,
              score: artifact.score,
            },
          ]
        : [],
    anchors: [],
    conflicts: [],
    receipt: {
      memoryCandidates: includeMemory ? 1 : 0,
      codeCandidates: includeCode && artifact ? 1 : 0,
      anchorCandidates: 0,
      requestedCommitOid: input.commitOid ?? null,
      memoryQuery: includeMemory ? (input.memoryQuery ?? input.query) : null,
      codeQuery: includeCode ? (input.codeQuery ?? input.query) : null,
      contextualImpact: null,
    },
  };
}

function fixtureContext(): LoreMcpContextClient {
  return { retrieveContext: async (input) => retrievedContext(input) };
}

export interface RetrievalPolicyMcpHarness {
  listTools(names?: readonly string[]): Promise<Awaited<ReturnType<Client["listTools"]>>["tools"]>;
  callTool(input: Parameters<Client["callTool"]>[0]): ReturnType<Client["callTool"]>;
  close(): Promise<void>;
}

export async function createRetrievalPolicyMcpHarness(): Promise<RetrievalPolicyMcpHarness> {
  const server = createLoreMcpServer({
    memories: fixtureMemories(),
    code: fixtureCode(),
    context: fixtureContext(),
  });
  const client = new Client({ name: "lore-retrieval-policy-benchmark", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    async listTools(names) {
      const { tools } = await client.listTools();
      if (!names) return tools;
      const selected = new Set(names);
      return tools.filter((tool) => selected.has(tool.name));
    },
    callTool: (input) => client.callTool(input),
    async close() {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}
