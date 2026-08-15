import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import suiteSource from "../evaluation/suites/retrieval-policy-v1.json";
import {
  planRetrievalGrounding,
  RETRIEVAL_GROUNDING_POLICY_REVISION,
} from "../src/lib/joint-memory-code";
import {
  aggregateRetrievalPolicyTrials,
  parseRetrievalPolicySuite,
  type RetrievalPolicyCase,
  type RetrievalPolicyToolCall,
  type RetrievalPolicyTrace,
  type RetrievalPolicyTrialScore,
  scoreRetrievalPolicyTrial,
} from "./lib/retrieval-policy-benchmark";
import { runCodexRetrievalPolicyTurn } from "./lib/retrieval-policy-codex";
import { createRetrievalPolicyMcpHarness } from "./lib/retrieval-policy-mcp";

type VariantId =
  | "primitive-auto"
  | "compound-auto"
  | "compound-guided"
  | "host-policy"
  | "host-forced-oracle"
  | "always-on";

interface Variant {
  id: VariantId;
  description: string;
  hostPolicy: "none" | "production" | "oracle-required" | "always";
  guidance: "generic" | "grounding-contract";
  tools: readonly string[];
}

interface TrialRecord {
  variant: VariantId;
  caseId: string;
  trial: number;
  score: RetrievalPolicyTrialScore;
  outcome: RetrievalPolicyTrace["assistantOutcome"];
  answer: string;
  toolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
    deliveredRoute: unknown;
  }>;
  inputTokens: number | null;
  outputTokens: number | null;
}

const PRIMITIVE_TOOLS = ["lore_search", "lore_code_search", "lore_code_dependencies"] as const;
const COMPOUND_TOOLS = ["lore_retrieve_context", ...PRIMITIVE_TOOLS] as const;
const VARIANTS: readonly Variant[] = [
  {
    id: "primitive-auto",
    description: "Primitive Memory and Code tools; model chooses whether and what to call.",
    hostPolicy: "none",
    guidance: "generic",
    tools: PRIMITIVE_TOOLS,
  },
  {
    id: "compound-auto",
    description: "Compound context tool plus primitives; model receives no trigger contract.",
    hostPolicy: "none",
    guidance: "generic",
    tools: COMPOUND_TOOLS,
  },
  {
    id: "compound-guided",
    description: "Compound context tool plus primitives and explicit grounding triggers.",
    hostPolicy: "none",
    guidance: "grounding-contract",
    tools: COMPOUND_TOOLS,
  },
  {
    id: "host-policy",
    description:
      "Production grounding gate chooses required, auto, or off before the model sees Lore tools.",
    hostPolicy: "production",
    guidance: "grounding-contract",
    tools: COMPOUND_TOOLS,
  },
  {
    id: "host-forced-oracle",
    description:
      "Evaluation upper bound: host invokes compound retrieval for labeled must-call/drill-down cases, then the model may use primitives.",
    hostPolicy: "oracle-required",
    guidance: "grounding-contract",
    tools: COMPOUND_TOOLS,
  },
  {
    id: "always-on",
    description:
      "Host invokes compound retrieval before every case, including transformations and brainstorming.",
    hostPolicy: "always",
    guidance: "grounding-contract",
    tools: COMPOUND_TOOLS,
  },
];

function optionalArgument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1]?.trim();
  if (!value) throw new Error(`--${name} requires a value`);
  return value;
}

function positiveIntegerArgument(name: string, fallback: number): number {
  const value = optionalArgument(name);
  const parsed = value === null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be positive`);
  return parsed;
}

function selectedVariants(): Variant[] {
  const value = optionalArgument("variants");
  if (!value) return [...VARIANTS];
  const selected = new Set(value.split(",").map((item) => item.trim()));
  const unknown = [...selected].filter((id) => !VARIANTS.some((variant) => variant.id === id));
  if (unknown.length > 0) throw new Error(`Unknown variants: ${unknown.join(", ")}`);
  return VARIANTS.filter((variant) => selected.has(variant.id));
}

function hostShouldRetrieve(variant: Variant, evaluationCase: RetrievalPolicyCase): boolean {
  if (variant.hostPolicy === "always") return true;
  if (variant.hostPolicy === "none") return false;
  if (variant.hostPolicy === "production") {
    return (
      planRetrievalGrounding({
        query: evaluationCase.prompt,
        hasRepositoryContext: Boolean(
          evaluationCase.expectation.repositoryKey && evaluationCase.expectation.commitOid,
        ),
      }).mode === "required"
    );
  }
  return (
    evaluationCase.expectation.invocation === "must-call" ||
    evaluationCase.expectation.invocation === "drill-down"
  );
}

function toolNamesFor(variant: Variant, evaluationCase: RetrievalPolicyCase): readonly string[] {
  if (variant.hostPolicy !== "production") return variant.tools;
  const plan = planRetrievalGrounding({
    query: evaluationCase.prompt,
    hasRepositoryContext: Boolean(
      evaluationCase.expectation.repositoryKey && evaluationCase.expectation.commitOid,
    ),
  });
  if (plan.mode === "off") return [];
  if (plan.mode === "required") return PRIMITIVE_TOOLS;
  return variant.tools;
}

function compoundArguments(evaluationCase: RetrievalPolicyCase): Record<string, unknown> {
  return {
    query: evaluationCase.prompt,
    route: "auto",
    ...(evaluationCase.expectation.repositoryKey && evaluationCase.expectation.commitOid
      ? {
          repositoryKey: evaluationCase.expectation.repositoryKey,
          commitOid: evaluationCase.expectation.commitOid,
        }
      : {}),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function hostRetrieval(
  evaluationCase: RetrievalPolicyCase,
): Promise<RetrievalPolicyToolCall> {
  const harness = await createRetrievalPolicyMcpHarness();
  const argumentsValue = compoundArguments(evaluationCase);
  try {
    const result = await harness.callTool({
      name: "lore_retrieve_context",
      arguments: argumentsValue,
    });
    return {
      name: "lore_retrieve_context",
      arguments: argumentsValue,
      result: result.structuredContent,
    };
  } finally {
    await harness.close();
  }
}

function promptFor(input: {
  evaluationCase: RetrievalPolicyCase;
  variant: Variant;
  hostCall: RetrievalPolicyToolCall | null;
}): string {
  const context: string[] = [
    "You are the model under a retrieval-policy evaluation.",
    "Answer the user's request accurately. Do not use shell, filesystem, or parametric guesses for Workspace or repository facts.",
  ];
  if (input.evaluationCase.expectation.repositoryKey) {
    context.push(`Configured repository key: ${input.evaluationCase.expectation.repositoryKey}.`);
  }
  if (input.evaluationCase.expectation.commitOid) {
    context.push(`Configured exact commit OID: ${input.evaluationCase.expectation.commitOid}.`);
  } else if (input.evaluationCase.expectation.repositoryKey) {
    context.push(
      "No exact commit OID is available. Do not invent one; ask the user to provide the exact revision if Code truth is required.",
    );
  }
  if (input.variant.guidance === "grounding-contract") {
    context.push(
      "Before answering, use lore_retrieve_context whenever correctness depends on prior Workspace decisions, user-specific facts, current code, or an exact repository revision. For a question comparing a decision with current code, retrieve both evidence families. Do not retrieve for a transformation fully supported by supplied text or for general brainstorming. If the first packet is incomplete, ambiguous, truncated, or lacks requested caller/callee edges, use the appropriate specialist Lore tool.",
    );
  } else {
    context.push("Use the available Lore tools when you judge them helpful.");
  }
  if (input.hostCall) {
    context.push(
      `The host already executed a read-only grounding call. Treat this as evidence, not as permission to guess beyond it:\n${JSON.stringify(input.hostCall.result)}`,
    );
  }
  context.push(
    "Return the required JSON object. Use outcome=clarified only when essential repository/revision context is missing; outcome=abstained when authorized evidence cannot support an answer.",
    `User request: ${input.evaluationCase.prompt}`,
  );
  return context.join("\n\n");
}

function deliveredRoute(call: RetrievalPolicyToolCall): unknown {
  return record(call.result)?.deliveredRoute ?? null;
}

function compactToolCalls(calls: readonly RetrievalPolicyToolCall[]): TrialRecord["toolCalls"] {
  return calls.map((call) => ({
    name: call.name,
    arguments: call.arguments,
    deliveredRoute: deliveredRoute(call),
  }));
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function markdownReport(report: {
  generatedAt: string;
  groundingPolicyRevision: string;
  model: string;
  trialsPerCase: number;
  suite: { name: string; version: number; caseCount: number };
  variants: Record<
    string,
    {
      description: string;
      metrics: ReturnType<typeof aggregateRetrievalPolicyTrials>;
      toolCalls: number;
      averageToolCalls: number;
      inputTokens: number;
      outputTokens: number;
    }
  >;
  records: TrialRecord[];
}): string {
  const lines = [
    `# ${report.suite.name} — ${report.model}`,
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Suite version: ${report.suite.version}; cases: ${report.suite.caseCount}; trials per case: ${report.trialsPerCase}.`,
    `Grounding policy: \`${report.groundingPolicyRevision}\`.`,
    "",
    "`host-policy` runs Lore's production deterministic grounding gate. `host-forced-oracle` uses benchmark labels only as an architectural upper bound.",
    "",
    "## Variant metrics",
    "",
    "| Variant | Pass | Required-call recall | Unnecessary-call rate | Route | Exact revision | Clarify | Drill-down | Calls | p95 ms | Input tokens |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [id, result] of Object.entries(report.variants)) {
    const metrics = result.metrics;
    lines.push(
      `| ${id} | ${percent(metrics.passRate)} | ${percent(metrics.requiredRetrievalRecall)} | ${percent(metrics.unnecessaryRetrievalRate)} | ${percent(metrics.routeAccuracy)} | ${percent(metrics.exactRevisionAccuracy)} | ${percent(metrics.clarificationAccuracy)} | ${percent(metrics.drillDownAccuracy)} | ${result.toolCalls} (${result.averageToolCalls.toFixed(2)}/case) | ${metrics.p95LatencyMs.toFixed(0)} | ${result.inputTokens} |`,
    );
  }
  lines.push(
    "",
    "## Case results",
    "",
    "| Variant | Case | Trial | Pass | Outcome | Calls | Route | Latency ms |",
    "|---|---|---:|---:|---|---|---|---:|",
  );
  for (const entry of report.records) {
    const calls = entry.toolCalls.map((call) => call.name).join(" → ") || "none";
    const route =
      entry.toolCalls
        .map((call) => call.deliveredRoute)
        .filter(Boolean)
        .join(" → ") || "—";
    lines.push(
      `| ${entry.variant} | ${entry.caseId} | ${entry.trial} | ${entry.score.passed ? "yes" : "no"} | ${entry.outcome} | ${calls} | ${route} | ${entry.score.latencyMs.toFixed(0)} |`,
    );
  }
  lines.push(
    "",
    "## Notes",
    "",
    "- The model saw schemas emitted by Lore's real MCP adapter. Tool results came from deterministic authorized benchmark fixtures.",
    "- `primitive-auto`, `compound-auto`, and `compound-guided` measure model-selected invocation. `host-policy` applies the production required/auto/off gate; the oracle and always-on variants remain controls.",
    "- Codex exec includes its agent harness context, so token counts are useful for comparing these variants but are not representative of a lean Responses API integration.",
    "",
  );
  return lines.join("\n");
}

const suite = parseRetrievalPolicySuite(suiteSource);
const model = optionalArgument("model") ?? "gpt-5.6-sol";
const trialsPerCase = positiveIntegerArgument("trials", 1);
const maximumCases = Math.min(
  positiveIntegerArgument("max-cases", suite.cases.length),
  suite.cases.length,
);
const caseFilter = optionalArgument("case");
const variants = selectedVariants();
const selectedCases = (
  caseFilter ? suite.cases.filter((entry) => entry.id === caseFilter) : suite.cases
).slice(0, maximumCases);
if (selectedCases.length === 0) throw new Error(`Unknown --case ${JSON.stringify(caseFilter)}`);

const records: TrialRecord[] = [];
for (const variant of variants) {
  for (const evaluationCase of selectedCases) {
    for (let trial = 1; trial <= trialsPerCase; trial += 1) {
      console.error(`[${variant.id}] ${evaluationCase.id} trial ${trial}/${trialsPerCase}`);
      const startedAt = performance.now();
      const hostCall = hostShouldRetrieve(variant, evaluationCase)
        ? await hostRetrieval(evaluationCase)
        : null;
      const modelTrace = await runCodexRetrievalPolicyTurn({
        model,
        toolNames: toolNamesFor(variant, evaluationCase),
        prompt: promptFor({ evaluationCase, variant, hostCall }),
      });
      const trace: RetrievalPolicyTrace = {
        ...modelTrace,
        latencyMs: performance.now() - startedAt,
        toolCalls: [...(hostCall ? [hostCall] : []), ...modelTrace.toolCalls],
      };
      records.push({
        variant: variant.id,
        caseId: evaluationCase.id,
        trial,
        score: scoreRetrievalPolicyTrial({ case: evaluationCase, trace }),
        outcome: trace.assistantOutcome,
        answer: modelTrace.answer,
        toolCalls: compactToolCalls(trace.toolCalls),
        inputTokens: trace.inputTokens ?? null,
        outputTokens: trace.outputTokens ?? null,
      });
    }
  }
}

const variantReports = Object.fromEntries(
  variants.map((variant) => {
    const selected = records.filter((entry) => entry.variant === variant.id);
    const toolCalls = selected.reduce((sum, entry) => sum + entry.toolCalls.length, 0);
    return [
      variant.id,
      {
        description: variant.description,
        metrics: aggregateRetrievalPolicyTrials(selected.map((entry) => entry.score)),
        toolCalls,
        averageToolCalls: selected.length === 0 ? 0 : toolCalls / selected.length,
        inputTokens: selected.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0),
        outputTokens: selected.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0),
      },
    ];
  }),
);
const report = {
  benchmark: "lore-retrieval-policy-v1",
  groundingPolicyRevision: RETRIEVAL_GROUNDING_POLICY_REVISION,
  generatedAt: new Date().toISOString(),
  provider: "OpenAI via Codex exec",
  model,
  trialsPerCase,
  suite: { name: suite.name, version: suite.version, caseCount: selectedCases.length },
  variants: variantReports,
  records,
};

const output = optionalArgument("output");
if (output) {
  const jsonPath = resolve(output.endsWith(".json") ? output : `${output}.json`);
  const markdownPath = jsonPath.replace(/\.json$/i, ".md");
  await mkdir(dirname(jsonPath), { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, markdownReport(report), "utf8"),
  ]);
  console.error(`Wrote ${jsonPath}`);
  console.error(`Wrote ${markdownPath}`);
}
console.log(JSON.stringify(report, null, 2));
