export type RetrievalPolicyInvocation =
  | "must-call"
  | "must-not-call"
  | "must-clarify"
  | "drill-down";

export type RetrievalPolicyRoute = "memory-only" | "code-only" | "both" | "abstain";

export type RetrievalPolicyOutcome = "answered" | "clarified" | "abstained";

export interface RetrievalPolicyCase {
  id: string;
  prompt: string;
  expectation: {
    invocation: RetrievalPolicyInvocation;
    route: RetrievalPolicyRoute;
    repositoryKey?: string;
    commitOid?: string;
    followupTool?: "lore_search" | "lore_code_search" | "lore_code_dependencies";
    /** Expected assistant outcome when fixture evidence makes one correct. */
    outcome?: RetrievalPolicyOutcome;
    /** Case-insensitive substrings the final answer must contain. */
    answerMustInclude?: readonly string[];
  };
}

export interface RetrievalPolicySuite {
  name: string;
  version: number;
  description: string;
  cases: RetrievalPolicyCase[];
}

export interface RetrievalPolicyToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
}

export interface RetrievalPolicyTrace {
  assistantOutcome: "answered" | "clarified" | "abstained" | "error";
  answer?: string;
  latencyMs: number;
  toolCalls: readonly RetrievalPolicyToolCall[];
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface RetrievalPolicyTrialScore {
  passed: boolean;
  invocationCorrect: boolean;
  routeCorrect: boolean | null;
  exactRevisionCorrect: boolean | null;
  clarificationCorrect: boolean | null;
  drillDownCorrect: boolean | null;
  outcomeCorrect: boolean | null;
  answerEvidenceCorrect: boolean | null;
  retrievalMiss: boolean;
  unnecessaryRetrieval: boolean;
  latencyMs: number;
}

export interface RetrievalPolicyAggregate {
  caseCount: number;
  passRate: number;
  requiredRetrievalRecall: number | null;
  unnecessaryRetrievalRate: number | null;
  routeAccuracy: number | null;
  exactRevisionAccuracy: number | null;
  clarificationAccuracy: number | null;
  drillDownAccuracy: number | null;
  outcomeAccuracy: number | null;
  answerEvidenceAccuracy: number | null;
  averageLatencyMs: number;
  p95LatencyMs: number;
}

const RETRIEVAL_TOOLS = new Set([
  "lore_retrieve_context",
  "lore_search",
  "lore_code_search",
  "lore_code_dependencies",
]);

const INVOCATIONS = new Set<RetrievalPolicyInvocation>([
  "must-call",
  "must-not-call",
  "must-clarify",
  "drill-down",
]);
const ROUTES = new Set<RetrievalPolicyRoute>(["memory-only", "code-only", "both", "abstain"]);
const FOLLOWUP_TOOLS = new Set([
  "lore_search",
  "lore_code_search",
  "lore_code_dependencies",
] as const);

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be non-empty`);
  return value.trim();
}

export function parseRetrievalPolicySuite(value: unknown): RetrievalPolicySuite {
  const source = object(value, "Retrieval policy suite");
  const version = source.version;
  if (!Number.isInteger(version) || Number(version) < 1) {
    throw new Error("Retrieval policy suite version must be a positive integer");
  }
  if (!Array.isArray(source.cases) || source.cases.length === 0) {
    throw new Error("Retrieval policy suite requires cases");
  }
  const ids = new Set<string>();
  const cases = source.cases.map((entry, index): RetrievalPolicyCase => {
    const candidate = object(entry, `cases[${index}]`);
    const id = text(candidate.id, `cases[${index}].id`);
    if (ids.has(id)) throw new Error(`Duplicate retrieval policy case ${JSON.stringify(id)}`);
    ids.add(id);
    const expected = object(candidate.expectation, `cases[${index}].expectation`);
    const invocation = expected.invocation;
    const route = expected.route;
    if (!INVOCATIONS.has(invocation as RetrievalPolicyInvocation)) {
      throw new Error(`cases[${index}].expectation.invocation is invalid`);
    }
    if (!ROUTES.has(route as RetrievalPolicyRoute)) {
      throw new Error(`cases[${index}].expectation.route is invalid`);
    }
    const repositoryKey =
      expected.repositoryKey === undefined
        ? undefined
        : text(expected.repositoryKey, `cases[${index}].expectation.repositoryKey`);
    const commitOid =
      expected.commitOid === undefined
        ? undefined
        : text(expected.commitOid, `cases[${index}].expectation.commitOid`).toLowerCase();
    if (commitOid && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitOid)) {
      throw new Error(`cases[${index}].expectation.commitOid must be a full Git OID`);
    }
    const followupTool = expected.followupTool;
    if (followupTool !== undefined && !FOLLOWUP_TOOLS.has(followupTool as never)) {
      throw new Error(`cases[${index}].expectation.followupTool is invalid`);
    }
    const outcome = expected.outcome;
    if (
      outcome !== undefined &&
      outcome !== "answered" &&
      outcome !== "clarified" &&
      outcome !== "abstained"
    ) {
      throw new Error(`cases[${index}].expectation.outcome is invalid`);
    }
    const answerMustInclude = expected.answerMustInclude;
    if (answerMustInclude !== undefined) {
      if (!Array.isArray(answerMustInclude) || answerMustInclude.length === 0) {
        throw new Error(`cases[${index}].expectation.answerMustInclude must be a non-empty array`);
      }
      for (const [position, needle] of answerMustInclude.entries()) {
        text(needle, `cases[${index}].expectation.answerMustInclude[${position}]`);
      }
    }
    if (invocation === "drill-down" && followupTool === undefined) {
      throw new Error(`cases[${index}] drill-down requires followupTool`);
    }
    if ((route === "code-only" || route === "both") && invocation !== "must-clarify") {
      if (!repositoryKey || !commitOid) {
        throw new Error(`cases[${index}] Code route requires repositoryKey and commitOid`);
      }
    }
    return {
      id,
      prompt: text(candidate.prompt, `cases[${index}].prompt`),
      expectation: {
        invocation: invocation as RetrievalPolicyInvocation,
        route: route as RetrievalPolicyRoute,
        ...(repositoryKey ? { repositoryKey } : {}),
        ...(commitOid ? { commitOid } : {}),
        ...(followupTool
          ? {
              followupTool: followupTool as NonNullable<
                RetrievalPolicyCase["expectation"]["followupTool"]
              >,
            }
          : {}),
        ...(outcome ? { outcome: outcome as RetrievalPolicyOutcome } : {}),
        ...(answerMustInclude
          ? { answerMustInclude: answerMustInclude.map((needle) => String(needle)) }
          : {}),
      },
    };
  });
  return {
    name: text(source.name, "Retrieval policy suite name"),
    version: Number(version),
    description: text(source.description, "Retrieval policy suite description"),
    cases,
  };
}

function deliveredRoute(call: RetrievalPolicyToolCall): RetrievalPolicyRoute | null {
  if (call.name === "lore_search") return "memory-only";
  if (call.name === "lore_code_search" || call.name === "lore_code_dependencies") {
    return "code-only";
  }
  if (call.name !== "lore_retrieve_context" || !call.result || typeof call.result !== "object") {
    return null;
  }
  const route = Reflect.get(call.result, "deliveredRoute");
  return route === "memory-only" || route === "code-only" || route === "both" || route === "abstain"
    ? route
    : null;
}

function observedRoute(calls: readonly RetrievalPolicyToolCall[]): RetrievalPolicyRoute | null {
  const delivered = calls.flatMap((call) => {
    const route = deliveredRoute(call);
    return route ? [route] : [];
  });
  const routes = delivered.some((route) => route !== "abstain")
    ? delivered.filter((route) => route !== "abstain")
    : delivered;
  if (routes.includes("both")) return "both";
  if (routes.includes("memory-only") && routes.includes("code-only")) return "both";
  return routes[0] ?? null;
}

function exactRevisionMatches(
  calls: readonly RetrievalPolicyToolCall[],
  expectation: RetrievalPolicyCase["expectation"],
): boolean | null {
  if (!expectation.repositoryKey || !expectation.commitOid) return null;
  const codeCalls = calls.filter((call) => {
    const route = deliveredRoute(call);
    return route === "code-only" || route === "both";
  });
  if (codeCalls.length === 0) return false;
  return codeCalls.every(
    (call) =>
      call.arguments.repositoryKey === expectation.repositoryKey &&
      call.arguments.commitOid === expectation.commitOid,
  );
}

export function scoreRetrievalPolicyTrial(input: {
  case: RetrievalPolicyCase;
  trace: RetrievalPolicyTrace;
}): RetrievalPolicyTrialScore {
  const retrievalCalls = input.trace.toolCalls.filter((call) => RETRIEVAL_TOOLS.has(call.name));
  const mustRetrieve =
    input.case.expectation.invocation === "must-call" ||
    input.case.expectation.invocation === "drill-down";
  const retrievalMiss = mustRetrieve && retrievalCalls.length === 0;
  const unnecessaryRetrieval =
    (input.case.expectation.invocation === "must-not-call" ||
      input.case.expectation.invocation === "must-clarify") &&
    retrievalCalls.length > 0;
  const invocationCorrect = mustRetrieve
    ? !retrievalMiss
    : input.case.expectation.invocation === "must-not-call"
      ? !unnecessaryRetrieval
      : input.case.expectation.invocation === "must-clarify"
        ? !unnecessaryRetrieval && input.trace.assistantOutcome === "clarified"
        : true;
  const routeCorrect = mustRetrieve
    ? observedRoute(retrievalCalls) === input.case.expectation.route
    : null;
  const exactRevisionCorrect = exactRevisionMatches(retrievalCalls, input.case.expectation);
  const clarificationCorrect =
    input.case.expectation.invocation === "must-clarify"
      ? input.trace.assistantOutcome === "clarified"
      : null;
  const drillDownCorrect =
    input.case.expectation.invocation === "drill-down"
      ? retrievalCalls.some((call) => call.name === input.case.expectation.followupTool)
      : null;
  const outcomeCorrect = input.case.expectation.outcome
    ? input.trace.assistantOutcome === input.case.expectation.outcome
    : null;
  const answer = (input.trace.answer ?? "").toLowerCase();
  const answerEvidenceCorrect = input.case.expectation.answerMustInclude
    ? input.case.expectation.answerMustInclude.every((needle) =>
        answer.includes(needle.toLowerCase()),
      )
    : null;
  const checks = [
    invocationCorrect,
    routeCorrect,
    exactRevisionCorrect,
    clarificationCorrect,
    drillDownCorrect,
    outcomeCorrect,
    answerEvidenceCorrect,
  ].filter((value): value is boolean => value !== null);

  return {
    passed: checks.every(Boolean),
    invocationCorrect,
    routeCorrect,
    exactRevisionCorrect,
    clarificationCorrect,
    drillDownCorrect,
    outcomeCorrect,
    answerEvidenceCorrect,
    retrievalMiss,
    unnecessaryRetrieval,
    latencyMs: input.trace.latencyMs,
  };
}

function rate(values: readonly boolean[]): number | null {
  return values.length === 0 ? null : values.filter(Boolean).length / values.length;
}

function present(values: readonly (boolean | null)[]): boolean[] {
  return values.filter((value): value is boolean => value !== null);
}

export function aggregateRetrievalPolicyTrials(
  scores: readonly RetrievalPolicyTrialScore[],
): RetrievalPolicyAggregate {
  const required = scores.filter((score) => score.routeCorrect !== null);
  const mustNotCall = scores.filter(
    (score) =>
      score.routeCorrect === null &&
      score.clarificationCorrect === null &&
      score.drillDownCorrect === null,
  );
  const latencies = scores.map((score) => score.latencyMs).sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);

  return {
    caseCount: scores.length,
    passRate: rate(scores.map((score) => score.passed)) ?? 0,
    requiredRetrievalRecall: rate(required.map((score) => !score.retrievalMiss)),
    unnecessaryRetrievalRate: rate(mustNotCall.map((score) => score.unnecessaryRetrieval)),
    routeAccuracy: rate(present(scores.map((score) => score.routeCorrect))),
    exactRevisionAccuracy: rate(present(scores.map((score) => score.exactRevisionCorrect))),
    clarificationAccuracy: rate(present(scores.map((score) => score.clarificationCorrect))),
    drillDownAccuracy: rate(present(scores.map((score) => score.drillDownCorrect))),
    outcomeAccuracy: rate(present(scores.map((score) => score.outcomeCorrect))),
    answerEvidenceAccuracy: rate(present(scores.map((score) => score.answerEvidenceCorrect))),
    averageLatencyMs:
      scores.length === 0
        ? 0
        : scores.reduce((total, score) => total + score.latencyMs, 0) / scores.length,
    p95LatencyMs: latencies[p95Index] ?? 0,
  };
}
