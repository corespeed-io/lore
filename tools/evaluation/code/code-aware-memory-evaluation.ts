export const CODE_AWARE_MEMORY_EVALUATION_REVISION = "code-aware-memory-foundation-v1";

export type CodeAwareMemoryEvaluationCategory =
  | "dependencies"
  | "evidence"
  | "isolation"
  | "retrieval"
  | "workflow";

export type CodeAwareMemoryEvaluationMetric =
  | "ambiguity_honesty"
  | "dependency_resolution"
  | "evidence_recall_at_k"
  | "exact_revision"
  | "no_answer_precision"
  | "rls_isolation"
  | "stale_classification"
  | "workflow_support";

export interface CodeAwareMemoryEvaluationCaseResult {
  id: string;
  category: CodeAwareMemoryEvaluationCategory;
  metric: CodeAwareMemoryEvaluationMetric;
  passed: boolean;
  hardFailure?: boolean;
  unsupported?: boolean;
  latencyMs: number;
  expected: string;
  observed: string;
  detail?: string;
}

export interface CodeAwareMemoryEvaluationThresholds {
  evidenceRecallAtK: number;
  exactRevisionIsolation: number;
  noAnswerPrecision: number;
  ambiguityHonesty: number;
  dependencyResolutionAccuracy: number;
  rlsIsolation: number;
  staleClassificationAccuracy: number;
  workflowSupport: number;
}

export interface CodeAwareMemoryEvaluationReport {
  revision: string;
  decision: "pass" | "fail";
  thresholds: CodeAwareMemoryEvaluationThresholds;
  summary: {
    caseCount: number;
    passedCount: number;
    failedCount: number;
    hardFailureCount: number;
    unsupportedCount: number;
    passRate: number;
  };
  metrics: {
    evidenceRecallAtK: number | null;
    exactRevisionIsolation: number | null;
    noAnswerPrecision: number | null;
    ambiguityHonesty: number | null;
    dependencyResolutionAccuracy: number | null;
    rlsIsolation: number | null;
    staleClassificationAccuracy: number | null;
    workflowSupport: number | null;
  };
  latency: { p50Ms: number; p95Ms: number; maxMs: number };
  cases: readonly CodeAwareMemoryEvaluationCaseResult[];
}

export interface ScoreCodeAwareMemoryEvaluationOptions {
  revision?: string;
  thresholds?: CodeAwareMemoryEvaluationThresholds;
}

export const CODE_AWARE_MEMORY_EVALUATION_THRESHOLDS: CodeAwareMemoryEvaluationThresholds = {
  evidenceRecallAtK: 0.9,
  exactRevisionIsolation: 1,
  noAnswerPrecision: 1,
  ambiguityHonesty: 1,
  dependencyResolutionAccuracy: 0.95,
  rlsIsolation: 1,
  staleClassificationAccuracy: 0.95,
  workflowSupport: 1,
};

function rate(
  results: readonly CodeAwareMemoryEvaluationCaseResult[],
  metric: CodeAwareMemoryEvaluationMetric,
): number | null {
  const matching = results.filter((result) => result.metric === metric);
  if (!matching.length) return null;
  return matching.filter((result) => result.passed).length / matching.length;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

export function scoreCodeAwareMemoryEvaluation(
  results: readonly CodeAwareMemoryEvaluationCaseResult[],
  options: ScoreCodeAwareMemoryEvaluationOptions = {},
): CodeAwareMemoryEvaluationReport {
  const revision = options.revision ?? CODE_AWARE_MEMORY_EVALUATION_REVISION;
  const thresholds = options.thresholds ?? CODE_AWARE_MEMORY_EVALUATION_THRESHOLDS;
  const passedCount = results.filter((result) => result.passed).length;
  const hardFailureCount = results.filter((result) => result.hardFailure && !result.passed).length;
  const metrics = {
    evidenceRecallAtK: rate(results, "evidence_recall_at_k"),
    exactRevisionIsolation: rate(results, "exact_revision"),
    noAnswerPrecision: rate(results, "no_answer_precision"),
    ambiguityHonesty: rate(results, "ambiguity_honesty"),
    dependencyResolutionAccuracy: rate(results, "dependency_resolution"),
    rlsIsolation: rate(results, "rls_isolation"),
    staleClassificationAccuracy: rate(results, "stale_classification"),
    workflowSupport: rate(results, "workflow_support"),
  };
  const measuredLatencies = results
    .map((result) => result.latencyMs)
    .filter((latency) => Number.isFinite(latency) && latency > 0)
    .sort((left, right) => left - right);
  const failedQualityGate = (
    Object.entries(metrics) as Array<[keyof typeof metrics, (typeof metrics)[keyof typeof metrics]]>
  ).some(([name, value]) => value !== null && value < thresholds[name]);

  return {
    revision,
    decision: hardFailureCount === 0 && !failedQualityGate ? "pass" : "fail",
    thresholds,
    summary: {
      caseCount: results.length,
      passedCount,
      failedCount: results.length - passedCount,
      hardFailureCount,
      unsupportedCount: results.filter((result) => result.unsupported).length,
      passRate: results.length ? passedCount / results.length : 0,
    },
    metrics,
    latency: {
      p50Ms: rounded(percentile(measuredLatencies, 0.5)),
      p95Ms: rounded(percentile(measuredLatencies, 0.95)),
      maxMs: rounded(measuredLatencies.at(-1) ?? 0),
    },
    cases: results,
  };
}
