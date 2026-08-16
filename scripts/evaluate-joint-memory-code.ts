import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createJointMemoryCodePrototypeSession,
  type JointPrototypeCaseResult,
  type JointPrototypeVariantId,
} from "./lib/joint-memory-code-prototype-fixture";

function optionalArgument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value?.trim()) throw new Error(`--${name} requires a value`);
  return value;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function rate(values: readonly (boolean | null)[]): number | null {
  const observed = values.filter((value): value is boolean => value !== null);
  if (!observed.length) return null;
  return rounded(observed.filter(Boolean).length / observed.length);
}

function score(results: readonly JointPrototypeCaseResult[]) {
  const expectedEvidence = results.reduce(
    (total, result) =>
      total + result.case.expectedMemoryKeys.length + result.case.expectedCodePaths.length,
    0,
  );
  const relevantEvidence = results.reduce((total, result) => total + result.relevantEvidence, 0);
  const retrievedEvidence = results.reduce((total, result) => total + result.retrievedEvidence, 0);
  return {
    routeAccuracy: rate(results.map((result) => result.checks.route)),
    memoryRecall: rate(results.map((result) => result.checks.memoryRecall)),
    memoryTop1Accuracy: rate(results.map((result) => result.checks.memoryTop1)),
    codeRecall: rate(results.map((result) => result.checks.codeRecall)),
    requiredEvidenceRecall: expectedEvidence ? rounded(relevantEvidence / expectedEvidence) : 1,
    evidencePrecision: retrievedEvidence ? rounded(relevantEvidence / retrievedEvidence) : 1,
    anchorStateAccuracy: rate(results.map((result) => result.checks.anchorState)),
    contextualImpactAccuracy: rate(results.map((result) => result.checks.contextualImpact)),
    conflictAccuracy: rate(results.map((result) => result.checks.conflict)),
    noLeakage: rate(results.map((result) => result.checks.noLeakage)),
    averageEvidenceItems: rounded(retrievedEvidence / Math.max(1, results.length)),
    retrievalHarmRate: rate(
      results.map((result) => result.retrievedEvidence > result.relevantEvidence),
    ),
  };
}

const outputPath = optionalArgument("output");
const strict = process.argv.includes("--strict");
const session = await createJointMemoryCodePrototypeSession();

try {
  const resultsByVariant = new Map<JointPrototypeVariantId, JointPrototypeCaseResult[]>();
  for (const variant of session.variants) {
    const results: JointPrototypeCaseResult[] = [];
    for (const evaluationCase of session.cases) {
      results.push(await session.runCase(evaluationCase, variant));
    }
    resultsByVariant.set(variant.id, results);
  }

  const variants = Object.fromEntries(
    [...resultsByVariant.entries()].map(([variant, results]) => [
      variant,
      {
        metrics: score(results),
        cases: results.map((result) => ({
          id: result.case.id,
          expectedRoute: result.case.expectedRoute,
          plannedRoute: result.packet.plan.route,
          deliveredRoute: result.packet.deliveredRoute,
          checks: result.checks,
          relevantEvidence: result.relevantEvidence,
          retrievedEvidence: result.retrievedEvidence,
          anchors: result.packet.anchors.map((anchor) => ({
            relationship: anchor.relationship,
            localState: anchor.localState,
            citedPath: anchor.citedPath,
            validatedPath: anchor.validatedPath,
          })),
          contextualImpact: result.packet.receipt.contextualImpact,
          conflicts: result.packet.conflicts,
        })),
      },
    ]),
  );
  const finalMetrics = variants["selective+contextual-impact"].metrics;
  const alwaysOnMetrics = variants["always-on-union"].metrics;
  const gates = {
    routeAccuracy: finalMetrics.routeAccuracy === 1,
    requiredEvidenceRecall: (finalMetrics.requiredEvidenceRecall ?? 0) >= 0.9,
    memoryTop1Accuracy: finalMetrics.memoryTop1Accuracy === 1,
    anchorStateAccuracy: finalMetrics.anchorStateAccuracy === 1,
    contextualImpactAccuracy: finalMetrics.contextualImpactAccuracy === 1,
    conflictAccuracy: finalMetrics.conflictAccuracy === 1,
    zeroLeakage: finalMetrics.noLeakage === 1,
    lessContextThanAlwaysOn:
      finalMetrics.averageEvidenceItems < alwaysOnMetrics.averageEvidenceItems,
    lowerHarmThanAlwaysOn:
      (finalMetrics.retrievalHarmRate ?? 1) < (alwaysOnMetrics.retrievalHarmRate ?? 1),
  };
  const report = {
    revision: "joint-memory-code-v2",
    decision: Object.values(gates).every(Boolean) ? "pass" : "fail",
    question:
      "Can selective typed orchestration beat independent/always-on retrieval while preserving provenance, freshness, exact revision, and RLS?",
    environment: {
      adapter: "PGlite scratch database",
      retrieval: "Lore lexical Memory search plus exact-revision Code search",
      modelCalls: 0,
      concurrency: 1,
    },
    scope: {
      covered:
        "routing, grouped evidence, typed side-effect-free anchor assessment, one-hop contextual impact, exact revision, no-answer, and cross-Workspace tripwires",
      excluded:
        "model answer quality, learned routing, reverse Code-to-Memory lookup, dynamic runtime edges, Git-authenticated ingestion, hosted Postgres plans, and production latency",
    },
    gates,
    variants,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  if (outputPath) {
    const absoluteOutputPath = resolve(outputPath);
    await mkdir(dirname(absoluteOutputPath), { recursive: true });
    await writeFile(absoluteOutputPath, serialized, "utf8");
  }
  if (strict && report.decision !== "pass") process.exitCode = 1;
} finally {
  await session.close();
}
