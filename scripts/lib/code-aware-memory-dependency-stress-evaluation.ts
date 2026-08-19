import type { ActorContext, PostgresDatabase } from "@corespeed/lore-core";
import {
  type CodeAwareMemoryEvaluationCaseResult,
  type CodeAwareMemoryEvaluationCategory,
  type CodeAwareMemoryEvaluationMetric,
  type CodeAwareMemoryEvaluationReport,
  scoreCodeAwareMemoryEvaluation,
} from "../../src/lib/code-aware-memory-evaluation";
import {
  type CodeDependencyEdge,
  type CodeDependencyQueryResult,
  createCodeDependencyGraphModule,
} from "../../src/lib/code-graph";
import { createCodeIndexModule } from "../../src/lib/code-index";

const COMMIT = "7".repeat(40);
const REVISION = "code-aware-memory-dependency-stress-v1";

export interface CodeAwareMemoryDependencyStressFixture {
  database: PostgresDatabase;
  alice: ActorContext;
}

interface Observation {
  passed: boolean;
  observed: string;
  detail?: string;
  hardFailure?: boolean;
}

interface Probe {
  id: string;
  category: CodeAwareMemoryEvaluationCategory;
  metric: CodeAwareMemoryEvaluationMetric;
  expected: string;
  hardFailure?: boolean;
}

async function measure(
  probe: Probe,
  observe: () => Promise<Observation> | Observation,
): Promise<CodeAwareMemoryEvaluationCaseResult> {
  const startedAt = performance.now();
  try {
    const observation = await observe();
    return {
      ...probe,
      hardFailure: observation.hardFailure ?? probe.hardFailure,
      passed: observation.passed,
      observed: observation.observed,
      detail: observation.detail,
      latencyMs: Math.max(0, performance.now() - startedAt),
    };
  } catch (error) {
    return {
      ...probe,
      passed: false,
      observed: `error:${error instanceof Error ? error.name : "unknown"}`,
      detail: error instanceof Error ? error.message : String(error),
      latencyMs: Math.max(0, performance.now() - startedAt),
    };
  }
}

function describeDependencies(result: CodeDependencyQueryResult): string {
  if (result.status !== "ok") return result.status;
  if (!result.edges.length) return "no edges";
  return result.edges
    .map(
      (edge) =>
        `${edge.kind}:${edge.targetText}:${edge.resolution}:${edge.to.symbol ?? edge.to.path ?? "none"}`,
    )
    .join(", ");
}

function resolvedDependency(
  result: CodeDependencyQueryResult,
  predicate: (edge: CodeDependencyEdge) => boolean,
): Observation {
  const matched = result.status === "ok" && result.edges.some(predicate);
  return { passed: matched, observed: describeDependencies(result) };
}

export async function runCodeAwareMemoryDependencyStressEvaluation(
  fixture: CodeAwareMemoryDependencyStressFixture,
): Promise<CodeAwareMemoryEvaluationReport> {
  const code = createCodeIndexModule(fixture.database);
  const graph = createCodeDependencyGraphModule(fixture.database);
  const repositoryKey = "evaluation/dependency-stress";
  const results: CodeAwareMemoryEvaluationCaseResult[] = [];

  await code.indexRevision(fixture.alice, {
    repositoryKey,
    displayName: "Dependency stress evaluation",
    commitOid: COMMIT,
    files: [
      {
        path: "src/alias-target.ts",
        content: "export function originalTarget() { return 'alias'; }\n",
      },
      {
        path: "src/alias-caller.ts",
        content: [
          'import { originalTarget as renamedTarget } from "./alias-target";',
          "export function aliasCaller() { return renamedTarget(); }",
        ].join("\n"),
      },
      {
        path: "src/barrel-target.ts",
        content: "export function barrelTarget() { return 'barrel'; }\n",
      },
      {
        path: "src/barrel.ts",
        content: 'export { barrelTarget } from "./barrel-target";\n',
      },
      {
        path: "src/barrel-caller.ts",
        content: [
          'import { barrelTarget } from "./barrel";',
          "export function barrelCaller() { return barrelTarget(); }",
        ].join("\n"),
      },
      {
        path: "src/default-target.ts",
        content: "export default function defaultTarget() { return 'default'; }\n",
      },
      {
        path: "src/default-caller.ts",
        content: [
          'import defaultTarget from "./default-target";',
          "export function defaultCaller() { return defaultTarget(); }",
        ].join("\n"),
      },
      {
        path: "src/namespace-target.ts",
        content: "export function namespaceTarget() { return 'namespace'; }\n",
      },
      {
        path: "src/namespace-caller.ts",
        content: [
          'import * as tools from "./namespace-target";',
          "export function namespaceCaller() { return tools.namespaceTarget(); }",
        ].join("\n"),
      },
      {
        path: "src/types.ts",
        content: "export interface StressUser { id: string }\n",
      },
      {
        path: "src/type-caller.ts",
        content: [
          'import type { StressUser as UserAlias } from "./types";',
          "export function loadAliasedUser(): UserAlias { return { id: 'one' }; }",
        ].join("\n"),
      },
      {
        path: "src/qualified.ts",
        content: [
          "export class QualifiedA { run() { return 'a'; } }",
          "export class QualifiedB { run() { return 'b'; } }",
          "export function executeQualified(client: QualifiedA) { return client.run(); }",
        ].join("\n"),
      },
      {
        path: "src/chunked.ts",
        content: [
          "export function chunkedCaller() { return chunkedTarget(); }",
          `export function chunkedTarget() { return ${JSON.stringify("x".repeat(6_500))}; }`,
        ].join("\n"),
      },
      {
        path: "src/view.tsx",
        content: [
          "export function StressCard() { return <div>card</div>; }",
          "export function StressScreen() { return <StressCard />; }",
        ].join("\n"),
      },
      {
        path: "src/js-target.js",
        content: "export function jsTarget() { return 'javascript'; }\n",
      },
      {
        path: "src/js-caller.js",
        content: [
          'import { jsTarget } from "./js-target";',
          "export function jsCaller() { return jsTarget(); }",
        ].join("\n"),
      },
      {
        path: "src/static.ts",
        content: [
          "export class StaticWorker { static execute() { return 1; } }",
          "export function callStatic() { return StaticWorker.execute(); }",
        ].join("\n"),
      },
      {
        path: "src/literals.ts",
        content: [
          "export const wildcardLiteral = 'wild%_marker';",
          "export const optionalValue = client?.profile;",
          "export const cjkEvidence = '代码感知记忆证据';",
        ].join("\n"),
      },
      {
        path: "src/destructuring.ts",
        content:
          "const source = { destructuredAlpha: 1, destructuredBeta: 2 };\nexport const { destructuredAlpha, destructuredBeta } = source;\n",
      },
      {
        path: "src/malformed.ts",
        content: "export function broken( {\n// malformedFallbackMarker\n",
      },
    ],
  });

  async function query(symbol: string): Promise<CodeDependencyQueryResult> {
    return graph.query(fixture.alice, {
      repositoryKey,
      commitOid: COMMIT,
      direction: "callees",
      symbol,
    });
  }

  results.push(
    await measure(
      {
        id: "dependencies/aliased-import-call",
        category: "dependencies",
        metric: "dependency_resolution",
        expected: "renamedTarget resolves to originalTarget",
      },
      async () =>
        resolvedDependency(
          await query("aliasCaller"),
          (edge) =>
            edge.kind === "calls" &&
            edge.resolution === "resolved" &&
            edge.to.symbol === "originalTarget",
        ),
    ),
    await measure(
      {
        id: "dependencies/barrel-reexport-call",
        category: "dependencies",
        metric: "dependency_resolution",
        expected: "barrelTarget resolves through barrel.ts",
      },
      async () =>
        resolvedDependency(
          await query("barrelCaller"),
          (edge) =>
            edge.kind === "calls" &&
            edge.resolution === "resolved" &&
            edge.to.symbol === "barrelTarget" &&
            edge.to.path === "src/barrel-target.ts",
        ),
    ),
    await measure(
      {
        id: "dependencies/default-import-call",
        category: "dependencies",
        metric: "dependency_resolution",
        expected: "defaultTarget resolves to default-target.ts",
      },
      async () =>
        resolvedDependency(
          await query("defaultCaller"),
          (edge) =>
            edge.kind === "calls" &&
            edge.resolution === "resolved" &&
            edge.to.symbol === "defaultTarget",
        ),
    ),
    await measure(
      {
        id: "dependencies/namespace-import-call",
        category: "dependencies",
        metric: "dependency_resolution",
        expected: "tools.namespaceTarget resolves to namespace-target.ts",
      },
      async () =>
        resolvedDependency(
          await query("namespaceCaller"),
          (edge) =>
            edge.kind === "calls" &&
            edge.resolution === "resolved" &&
            edge.to.symbol === "namespaceTarget",
        ),
    ),
    await measure(
      {
        id: "dependencies/aliased-type-reference",
        category: "dependencies",
        metric: "dependency_resolution",
        expected: "UserAlias resolves to StressUser",
      },
      async () =>
        resolvedDependency(
          await query("loadAliasedUser"),
          (edge) =>
            edge.kind === "references" &&
            edge.resolution === "resolved" &&
            edge.to.symbol === "StressUser",
        ),
    ),
    await measure(
      {
        id: "dependencies/qualified-object-no-false-resolution",
        category: "dependencies",
        metric: "ambiguity_honesty",
        expected: "client.run is retained but not guessed as one class method",
      },
      async () => {
        const found = await query("executeQualified");
        const edge =
          found.status === "ok"
            ? found.edges.find(
                (candidate) => candidate.kind === "calls" && candidate.targetText === "client.run",
              )
            : undefined;
        return {
          passed: Boolean(edge && edge.resolution !== "resolved"),
          observed: describeDependencies(found),
          hardFailure: edge?.resolution === "resolved",
        };
      },
    ),
    await measure(
      {
        id: "dependencies/chunked-declaration",
        category: "dependencies",
        metric: "dependency_resolution",
        expected: "chunkedTarget resolves once across declaration chunks",
      },
      async () =>
        resolvedDependency(
          await query("chunkedCaller"),
          (edge) =>
            edge.kind === "calls" &&
            edge.resolution === "resolved" &&
            edge.to.symbol === "chunkedTarget",
        ),
    ),
    await measure(
      {
        id: "dependencies/tsx-component-reference",
        category: "dependencies",
        metric: "dependency_resolution",
        expected: "StressScreen references StressCard",
      },
      async () =>
        resolvedDependency(
          await query("StressScreen"),
          (edge) => edge.resolution === "resolved" && edge.to.symbol === "StressCard",
        ),
    ),
    await measure(
      {
        id: "dependencies/javascript-import-call",
        category: "dependencies",
        metric: "dependency_resolution",
        expected: "jsCaller resolves jsTarget",
      },
      async () =>
        resolvedDependency(
          await query("jsCaller"),
          (edge) =>
            edge.kind === "calls" &&
            edge.resolution === "resolved" &&
            edge.to.symbol === "jsTarget",
        ),
    ),
    await measure(
      {
        id: "dependencies/static-method-call",
        category: "dependencies",
        metric: "dependency_resolution",
        expected: "StaticWorker.execute resolves to its method declaration",
      },
      async () =>
        resolvedDependency(
          await query("callStatic"),
          (edge) =>
            edge.kind === "calls" &&
            edge.resolution === "resolved" &&
            edge.to.symbol === "StaticWorker.execute",
        ),
    ),
  );

  async function retrieval(
    id: string,
    queryText: string,
    expectedPath: string,
  ): Promise<CodeAwareMemoryEvaluationCaseResult> {
    return measure(
      {
        id,
        category: "retrieval",
        metric: "evidence_recall_at_k",
        expected: expectedPath,
      },
      async () => {
        const found = await code.search(fixture.alice, {
          repositoryKey,
          commitOid: COMMIT,
          query: queryText,
          limit: 10,
        });
        const paths = found.map((artifact) => artifact.path);
        return {
          passed: paths.includes(expectedPath),
          observed: paths.join(", ") || "no results",
        };
      },
    );
  }

  results.push(
    await retrieval("retrieval/sql-wildcard-literal", "%_", "src/literals.ts"),
    await retrieval("retrieval/optional-chain-punctuation", "?.", "src/literals.ts"),
    await retrieval("retrieval/cjk-literal", "代码感知记忆证据", "src/literals.ts"),
    await retrieval("retrieval/destructured-alpha", "destructuredAlpha", "src/destructuring.ts"),
    await retrieval("retrieval/destructured-beta", "destructuredBeta", "src/destructuring.ts"),
    await retrieval(
      "retrieval/malformed-source-fallback",
      "malformedFallbackMarker",
      "src/malformed.ts",
    ),
  );

  return scoreCodeAwareMemoryEvaluation(results, { revision: REVISION });
}
