import { expect, test } from "vitest";
import {
  CODE_AWARE_MEMORY_EVALUATION_REVISION,
  scoreCodeAwareMemoryEvaluation,
} from "@/lib/code-aware-memory-evaluation";
import { runCodeAwareMemoryFoundationEvaluation } from "../scripts/lib/code-aware-memory-foundation-evaluation";
import { createMemoryTestContext } from "./support/memory-context";

test("code-aware evaluation keeps hard failures separate from aggregate quality", () => {
  const report = scoreCodeAwareMemoryEvaluation([
    {
      id: "retrieval/exact-symbol",
      category: "retrieval",
      metric: "evidence_recall_at_k",
      passed: true,
      latencyMs: 8,
      expected: "src/guard.ts",
      observed: "src/guard.ts",
    },
    {
      id: "dependencies/ambiguous-target",
      category: "dependencies",
      metric: "ambiguity_honesty",
      passed: false,
      hardFailure: true,
      latencyMs: 12,
      expected: "ambiguous",
      observed: "resolved",
    },
    {
      id: "isolation/cross-workspace",
      category: "isolation",
      metric: "rls_isolation",
      passed: true,
      hardFailure: true,
      latencyMs: 4,
      expected: "no results",
      observed: "no results",
    },
    {
      id: "workflow/proposal-code-evidence",
      category: "workflow",
      metric: "workflow_support",
      passed: false,
      unsupported: true,
      latencyMs: 0,
      expected: "proposal carries immutable code anchor",
      observed: "no proposal-to-code evidence interface",
    },
  ]);

  expect(report).toMatchObject({
    revision: CODE_AWARE_MEMORY_EVALUATION_REVISION,
    decision: "fail",
    summary: {
      caseCount: 4,
      passedCount: 2,
      failedCount: 2,
      hardFailureCount: 1,
      unsupportedCount: 1,
      passRate: 0.5,
    },
    metrics: {
      evidenceRecallAtK: 1,
      ambiguityHonesty: 0,
      rlsIsolation: 1,
      staleClassificationAccuracy: null,
      workflowSupport: 0,
    },
  });
  expect(report.latency).toEqual({ p50Ms: 8, p95Ms: 12, maxMs: 12 });
});

test("code-aware evaluation passes only when every hard gate and configured quality gate passes", () => {
  const report = scoreCodeAwareMemoryEvaluation([
    {
      id: "retrieval/exact-symbol",
      category: "retrieval",
      metric: "evidence_recall_at_k",
      passed: true,
      latencyMs: 2,
      expected: "hit",
      observed: "hit",
    },
    {
      id: "dependencies/ambiguous-target",
      category: "dependencies",
      metric: "ambiguity_honesty",
      passed: true,
      hardFailure: true,
      latencyMs: 3,
      expected: "ambiguous",
      observed: "ambiguous",
    },
    {
      id: "evidence/moved",
      category: "evidence",
      metric: "stale_classification",
      passed: true,
      hardFailure: true,
      latencyMs: 4,
      expected: "moved",
      observed: "moved",
    },
    {
      id: "isolation/revoked",
      category: "isolation",
      metric: "rls_isolation",
      passed: true,
      hardFailure: true,
      latencyMs: 5,
      expected: "denied",
      observed: "denied",
    },
    {
      id: "workflow/accepted-citation",
      category: "workflow",
      metric: "workflow_support",
      passed: true,
      latencyMs: 6,
      expected: "cited",
      observed: "cited",
    },
  ]);

  expect(report.decision).toBe("pass");
  expect(report.summary.passRate).toBe(1);
});

test("code-aware evaluation reports keep independent suite revisions", () => {
  const report = scoreCodeAwareMemoryEvaluation([], {
    revision: "code-aware-memory-dependency-stress-v1",
  });

  expect(report.revision).toBe("code-aware-memory-dependency-stress-v1");
});

test("current Code and Memory modules produce a versioned adversarial foundation baseline", async () => {
  const context = await createMemoryTestContext();
  const report = await runCodeAwareMemoryFoundationEvaluation(context);

  expect(report).toMatchObject({
    revision: CODE_AWARE_MEMORY_EVALUATION_REVISION,
    decision: "pass",
    summary: {
      caseCount: 24,
      passedCount: 24,
      failedCount: 0,
      hardFailureCount: 0,
      unsupportedCount: 0,
    },
    metrics: {
      evidenceRecallAtK: 1,
      exactRevisionIsolation: 1,
      noAnswerPrecision: 1,
      ambiguityHonesty: 1,
      dependencyResolutionAccuracy: 1,
      rlsIsolation: 1,
      staleClassificationAccuracy: 1,
      workflowSupport: 1,
    },
  });
  expect(report.cases.filter((result) => !result.passed)).toEqual([]);
});
