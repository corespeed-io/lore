import { expect, test } from "vitest";
import retrievalPolicySuite from "../evaluation/suites/retrieval-policy-v1.json";
import {
  aggregateRetrievalPolicyTrials,
  parseRetrievalPolicySuite,
  scoreRetrievalPolicyTrial,
} from "../scripts/lib/retrieval-policy-benchmark";
import {
  codexRetrievalPolicyToolFilter,
  parseCodexRetrievalPolicyArtifacts,
} from "../scripts/lib/retrieval-policy-codex";
import { createRetrievalPolicyMcpHarness } from "../scripts/lib/retrieval-policy-mcp";

const COMMIT_OID = "a".repeat(40);

test("the Codex harness represents an intentionally empty tool set explicitly", () => {
  expect(codexRetrievalPolicyToolFilter([])).toBe("__none__");
  expect(codexRetrievalPolicyToolFilter(["lore_retrieve_context"])).toBe("lore_retrieve_context");
});

test("a compound exact-revision Code retrieval satisfies a must-call policy case", () => {
  const score = scoreRetrievalPolicyTrial({
    case: {
      id: "code/current-implementation",
      prompt: "Where is the current proposal guard implemented?",
      expectation: {
        invocation: "must-call",
        route: "code-only",
        repositoryKey: "corespeed/lore",
        commitOid: COMMIT_OID,
      },
    },
    trace: {
      assistantOutcome: "answered",
      latencyMs: 120,
      toolCalls: [
        {
          name: "lore_retrieve_context",
          arguments: {
            query: "Where is the current proposal guard implemented?",
            repositoryKey: "corespeed/lore",
            commitOid: COMMIT_OID,
          },
          result: { deliveredRoute: "code-only" },
        },
      ],
    },
  });

  expect(score).toEqual({
    passed: true,
    invocationCorrect: true,
    routeCorrect: true,
    exactRevisionCorrect: true,
    clarificationCorrect: null,
    drillDownCorrect: null,
    retrievalMiss: false,
    unnecessaryRetrieval: false,
    latencyMs: 120,
  });
});

test("the versioned policy suite covers every invocation class with unique cases", () => {
  const suite = parseRetrievalPolicySuite(retrievalPolicySuite);
  expect(suite.version).toBe(1);
  expect(new Set(suite.cases.map((entry) => entry.id)).size).toBe(suite.cases.length);
  expect(new Set(suite.cases.map((entry) => entry.expectation.invocation))).toEqual(
    new Set(["must-call", "must-not-call", "must-clarify", "drill-down"]),
  );
});

test("Codex benchmark traces keep MCP calls, outcomes, and actual token usage", () => {
  const trace = parseCodexRetrievalPolicyArtifacts({
    eventJsonLines: [
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 120, output_tokens: 18 },
      }),
    ],
    toolTraceJsonLines: [
      JSON.stringify({
        name: "lore_retrieve_context",
        arguments: { query: "Where?" },
        result: { deliveredRoute: "code-only" },
      }),
    ],
    finalOutput: JSON.stringify({ outcome: "answered", answer: "src/lib/memory.ts" }),
    latencyMs: 250,
  });

  expect(trace).toEqual({
    assistantOutcome: "answered",
    answer: "src/lib/memory.ts",
    latencyMs: 250,
    inputTokens: 120,
    outputTokens: 18,
    toolCalls: [
      {
        name: "lore_retrieve_context",
        arguments: { query: "Where?" },
        result: { deliveredRoute: "code-only" },
      },
    ],
  });
});

test("the model-facing harness uses Lore's real compound MCP contract", async () => {
  const harness = await createRetrievalPolicyMcpHarness();
  try {
    const tools = await harness.listTools(["lore_retrieve_context"]);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "lore_retrieve_context",
      description: expect.stringContaining("exact-revision Code Index"),
    });
    expect(JSON.stringify(tools[0]?.inputSchema)).toContain("repositoryKey");

    const result = await harness.callTool({
      name: "lore_retrieve_context",
      arguments: {
        query: "Where is the current proposal guard implemented?",
        repositoryKey: "corespeed/lore",
        commitOid: COMMIT_OID,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ deliveredRoute: "code-only" });
  } finally {
    await harness.close();
  }
});

test("aggregate metrics expose required retrieval misses separately from unnecessary calls", () => {
  const scores = [
    scoreRetrievalPolicyTrial({
      case: {
        id: "memory/prior-decision",
        prompt: "What did we decide?",
        expectation: { invocation: "must-call", route: "memory-only" },
      },
      trace: {
        assistantOutcome: "answered",
        latencyMs: 40,
        toolCalls: [
          {
            name: "lore_retrieve_context",
            arguments: { query: "What did we decide?" },
            result: { deliveredRoute: "memory-only" },
          },
        ],
      },
    }),
    scoreRetrievalPolicyTrial({
      case: {
        id: "code/stale-answer",
        prompt: "What does the exact revision do?",
        expectation: { invocation: "must-call", route: "code-only" },
      },
      trace: { assistantOutcome: "answered", latencyMs: 60, toolCalls: [] },
    }),
    scoreRetrievalPolicyTrial({
      case: {
        id: "general/rewrite",
        prompt: "Rewrite the supplied sentence.",
        expectation: { invocation: "must-not-call", route: "abstain" },
      },
      trace: {
        assistantOutcome: "answered",
        latencyMs: 20,
        toolCalls: [
          {
            name: "lore_search",
            arguments: { query: "Rewrite the supplied sentence." },
          },
        ],
      },
    }),
  ];

  expect(aggregateRetrievalPolicyTrials(scores)).toEqual({
    caseCount: 3,
    passRate: 1 / 3,
    requiredRetrievalRecall: 0.5,
    unnecessaryRetrievalRate: 1,
    routeAccuracy: 0.5,
    exactRevisionAccuracy: null,
    clarificationAccuracy: null,
    drillDownAccuracy: null,
    averageLatencyMs: 40,
    p95LatencyMs: 60,
  });
});

test("a missing exact revision requires clarification and rejects speculative Code retrieval", () => {
  expect(
    scoreRetrievalPolicyTrial({
      case: {
        id: "clarify/missing-commit",
        prompt: "Where is submitMemoryProposal implemented?",
        expectation: {
          invocation: "must-clarify",
          route: "abstain",
          repositoryKey: "corespeed/lore",
        },
      },
      trace: {
        assistantOutcome: "answered",
        latencyMs: 50,
        toolCalls: [
          {
            name: "lore_code_search",
            arguments: {
              repositoryKey: "corespeed/lore",
              commitOid: "b".repeat(40),
              query: "submitMemoryProposal",
            },
          },
        ],
      },
    }),
  ).toMatchObject({
    passed: false,
    invocationCorrect: false,
    clarificationCorrect: false,
    unnecessaryRetrieval: true,
  });
});

test("a specialist follow-up can recover from an initial compound abstention", () => {
  expect(
    scoreRetrievalPolicyTrial({
      case: {
        id: "memory/multilingual-recovery",
        prompt: "我们之前是怎么决定的？",
        expectation: { invocation: "must-call", route: "memory-only" },
      },
      trace: {
        assistantOutcome: "answered",
        latencyMs: 80,
        toolCalls: [
          {
            name: "lore_retrieve_context",
            arguments: { query: "我们之前是怎么决定的？" },
            result: { deliveredRoute: "abstain" },
          },
          {
            name: "lore_search",
            arguments: { query: "人工审核 决定" },
          },
        ],
      },
    }),
  ).toMatchObject({ passed: true, routeCorrect: true, retrievalMiss: false });
});

test("a direct specialist dependency call satisfies a drill-down case", () => {
  expect(
    scoreRetrievalPolicyTrial({
      case: {
        id: "drill-down/direct-callers",
        prompt: "Which direct callers depend on submitMemoryProposal?",
        expectation: {
          invocation: "drill-down",
          route: "code-only",
          repositoryKey: "corespeed/lore",
          commitOid: COMMIT_OID,
          followupTool: "lore_code_dependencies",
        },
      },
      trace: {
        assistantOutcome: "answered",
        latencyMs: 70,
        toolCalls: [
          {
            name: "lore_code_dependencies",
            arguments: {
              repositoryKey: "corespeed/lore",
              commitOid: COMMIT_OID,
              symbol: "submitMemoryProposal",
              direction: "callers",
            },
          },
        ],
      },
    }),
  ).toMatchObject({ passed: true, drillDownCorrect: true });
});
