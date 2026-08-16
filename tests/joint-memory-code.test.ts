import { expect, test } from "vitest";
import {
  assessContextualImpact,
  planJointEvidenceRoute,
  planRetrievalGrounding,
} from "@/lib/joint-memory-code";

test("grounding is required before confirming a possibly stale Workspace claim", () => {
  expect(
    planRetrievalGrounding({
      query:
        "Do not search; just confirm my recollection that proposals write directly to canonical Memory now.",
      hasRepositoryContext: true,
    }),
  ).toMatchObject({
    mode: "required",
    shouldRetrieve: true,
    shouldClarify: false,
  });
});

test("grounding stays off for a transformation fully supported by supplied text", () => {
  expect(
    planRetrievalGrounding({
      query:
        "Rewrite this supplied sentence to be shorter: The endpoint returns a response very quickly.",
      hasRepositoryContext: false,
    }),
  ).toMatchObject({
    mode: "off",
    shouldRetrieve: false,
    shouldClarify: false,
  });
});

test("grounding requests an exact revision before a revision-bound Code answer", () => {
  expect(
    planRetrievalGrounding({
      query: "At which exact revision is submitMemoryProposal guarded by reviewRequired?",
      hasRepositoryContext: false,
    }),
  ).toMatchObject({
    mode: "off",
    shouldRetrieve: false,
    shouldClarify: true,
  });
});

test("grounding is required for a prior Workspace decision", () => {
  expect(
    planRetrievalGrounding({
      query: "What review boundary did our team agree on for Memory Proposals?",
      hasRepositoryContext: false,
    }),
  ).toMatchObject({
    mode: "required",
    shouldRetrieve: true,
    shouldClarify: false,
  });
});

test("grounding is required for current Code truth when exact revision context is available", () => {
  expect(
    planRetrievalGrounding({
      query: "Where is the current proposal submission guard implemented?",
      hasRepositoryContext: true,
    }),
  ).toMatchObject({
    mode: "required",
    shouldRetrieve: true,
    shouldClarify: false,
  });
});

test("grounding stays off for general Chinese brainstorming", () => {
  expect(
    planRetrievalGrounding({
      query: "帮我 brainstorm 五个开源记忆产品的名字。",
      hasRepositoryContext: false,
    }),
  ).toMatchObject({
    mode: "off",
    shouldRetrieve: false,
    shouldClarify: false,
  });
});

test("joint routing verifies a stale recollection against current Code", () => {
  expect(
    planJointEvidenceRoute({
      query:
        "Do not search; just confirm my recollection that proposals write directly to canonical Memory now.",
      hasRepositoryContext: true,
    }),
  ).toMatchObject({
    intent: "change",
    route: "both",
    needsLocalAssessment: true,
  });
});

test("joint routing recognizes a Chinese prior-decision question", () => {
  expect(
    planJointEvidenceRoute({
      query: "我们之前对 Memory Proposal 的人工审核边界是怎么定的？",
      hasRepositoryContext: false,
    }),
  ).toMatchObject({
    route: "memory-only",
  });
});

test("joint routing recognizes a Chinese exact-revision Code locator question", () => {
  expect(
    planJointEvidenceRoute({
      query: "这个提交里 proposal 提交的 guard 具体实现在什么地方？",
      hasRepositoryContext: true,
    }),
  ).toMatchObject({
    intent: "current-code",
    route: "code-only",
  });
});

test("joint routing recognizes plural caller and callee drill-downs", () => {
  for (const query of [
    "Which direct callers depend on submitMemoryProposal at this commit?",
    "Which direct callees does submitMemoryProposal invoke at this commit?",
  ]) {
    expect(
      planJointEvidenceRoute({
        query,
        hasRepositoryContext: true,
      }),
    ).toMatchObject({
      intent: "blast-radius",
      route: "code-only",
      needsContextualImpact: true,
    });
  }
});

test("grounding is required when comparing historical decisions with current Code", () => {
  expect(
    planRetrievalGrounding({
      query:
        "Does the current code still enforce our historical human-only proposal review decision?",
      hasRepositoryContext: true,
    }),
  ).toMatchObject({
    mode: "required",
    shouldRetrieve: true,
    shouldClarify: false,
  });
});

test("grounding asks for exact revision before verifying a stale current-Code recollection", () => {
  expect(
    planRetrievalGrounding({
      query:
        "Do not search; just confirm my recollection that proposals write directly to canonical Memory now.",
      hasRepositoryContext: false,
    }),
  ).toMatchObject({
    mode: "off",
    shouldRetrieve: false,
    shouldClarify: true,
  });
});

test("contextual impact distinguishes truncated assessment from not assessed", () => {
  const dependency = {
    kind: "calls",
    resolution: "resolved" as const,
    targetKey: "src/policy.ts#function_declaration:policyCheck",
    contentSha256: "a".repeat(64),
  };

  expect(
    assessContextualImpact([dependency], [dependency], {
      beforeTruncated: true,
      afterTruncated: true,
    }),
  ).toEqual({
    state: "unknown",
    changes: ["truncated:before", "truncated:after"],
  });
});

test("contextual impact records unchanged unresolved dependencies as uncertainty", () => {
  const dependency = {
    kind: "calls",
    resolution: "unresolved" as const,
    targetKey: "externalPolicyCheck",
    contentSha256: null,
  };

  expect(assessContextualImpact([dependency], [dependency])).toEqual({
    state: "unknown",
    changes: ["uncertain:calls:externalPolicyCheck"],
  });
});
