import type { ActorContext } from "../../src/lib/actor-context";
import {
  type CodeAwareMemoryEvaluationCaseResult,
  type CodeAwareMemoryEvaluationCategory,
  type CodeAwareMemoryEvaluationMetric,
  type CodeAwareMemoryEvaluationReport,
  scoreCodeAwareMemoryEvaluation,
} from "../../src/lib/code-aware-memory-evaluation";
import {
  CodeEvidenceAccessDeniedError,
  createCodeEvidenceModule,
} from "../../src/lib/code-evidence";
import { createCodeDependencyGraphModule } from "../../src/lib/code-graph";
import { createCodeIndexModule } from "../../src/lib/code-index";
import type { PostgresDatabase } from "../../src/lib/db";
import { createMemoryModule } from "../../src/lib/memory";
import { createMemoryProposalsModule } from "../../src/lib/memory-proposals";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const COMMIT_D = "d".repeat(40);
const COMMIT_E = "e".repeat(40);
const COMMIT_F = "f".repeat(40);

export interface CodeAwareMemoryFoundationFixture {
  database: PostgresDatabase;
  alice: ActorContext;
  bob: ActorContext;
  carol: ActorContext;
  suspendMembership(actor: ActorContext): Promise<void>;
}

interface Observation {
  passed: boolean;
  observed: string;
  detail?: string;
}

interface Probe {
  id: string;
  category: CodeAwareMemoryEvaluationCategory;
  metric: CodeAwareMemoryEvaluationMetric;
  expected: string;
  hardFailure?: boolean;
  unsupported?: boolean;
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

function includesPath(results: readonly { path: string }[], path: string): Observation {
  const paths = results.map((result) => result.path);
  return { passed: paths.includes(path), observed: paths.join(", ") || "no results" };
}

export async function runCodeAwareMemoryFoundationEvaluation(
  fixture: CodeAwareMemoryFoundationFixture,
): Promise<CodeAwareMemoryEvaluationReport> {
  const code = createCodeIndexModule(fixture.database);
  const dependencies = createCodeDependencyGraphModule(fixture.database);
  const evidence = createCodeEvidenceModule(fixture.database);
  const memories = {
    ...createMemoryModule(fixture.database),
    ...createMemoryProposalsModule(fixture.database),
  };
  const results: CodeAwareMemoryEvaluationCaseResult[] = [];
  const mainRepositoryKey = "evaluation/code-aware-foundation";

  await code.indexRevision(fixture.alice, {
    repositoryKey: mainRepositoryKey,
    displayName: "Code-aware foundation evaluation",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/guard.ts",
        content: [
          "export function deploymentGuard() { return 'exactOldMarker'; }",
          "export const punctuationPipeline = (value: string) => value.trim();",
        ].join("\n"),
      },
      { path: "src/helper.ts", content: "export function helper() { return 'helper'; }\n" },
      {
        path: "src/caller.ts",
        content: [
          'import { helper } from "./helper";',
          "export function caller() { return helper(); }",
        ].join("\n"),
      },
      {
        path: "src/orphan.ts",
        content: "export function orphanTarget() { return 'not-imported'; }\n",
      },
      {
        path: "src/orphan-caller.ts",
        content: "export function orphanCaller() { return orphanTarget(); }\n",
      },
      {
        path: "src/worker.ts",
        content: [
          "export class Worker {",
          "  run() { return this.work(); }",
          "  work() { return 1; }",
          "}",
        ].join("\n"),
      },
    ],
  });
  await code.indexRevision(fixture.alice, {
    repositoryKey: mainRepositoryKey,
    displayName: "Code-aware foundation evaluation",
    commitOid: COMMIT_B,
    files: [
      {
        path: "src/guard.ts",
        content: "export function deploymentGuard() { return 'exactNewMarker'; }\n",
      },
    ],
  });

  results.push(
    await measure(
      {
        id: "retrieval/exact-symbol",
        category: "retrieval",
        metric: "evidence_recall_at_k",
        expected: "src/guard.ts",
      },
      async () =>
        includesPath(
          await code.search(fixture.alice, {
            repositoryKey: mainRepositoryKey,
            commitOid: COMMIT_A,
            query: "deploymentGuard",
            limit: 5,
          }),
          "src/guard.ts",
        ),
    ),
    await measure(
      {
        id: "retrieval/exact-path",
        category: "retrieval",
        metric: "evidence_recall_at_k",
        expected: "src/guard.ts",
      },
      async () =>
        includesPath(
          await code.search(fixture.alice, {
            repositoryKey: mainRepositoryKey,
            commitOid: COMMIT_A,
            query: "src/guard.ts",
            limit: 5,
          }),
          "src/guard.ts",
        ),
    ),
    await measure(
      {
        id: "retrieval/punctuation-literal",
        category: "retrieval",
        metric: "evidence_recall_at_k",
        expected: "src/guard.ts",
      },
      async () =>
        includesPath(
          await code.search(fixture.alice, {
            repositoryKey: mainRepositoryKey,
            commitOid: COMMIT_A,
            query: "=>",
            limit: 5,
          }),
          "src/guard.ts",
        ),
    ),
    await measure(
      {
        id: "retrieval/exact-revision",
        category: "retrieval",
        metric: "exact_revision",
        expected: "no exactOldMarker result at commit B",
        hardFailure: true,
      },
      async () => {
        const found = await code.search(fixture.alice, {
          repositoryKey: mainRepositoryKey,
          commitOid: COMMIT_B,
          query: "exactOldMarker",
          limit: 5,
        });
        return { passed: found.length === 0, observed: `${found.length} results` };
      },
    ),
    await measure(
      {
        id: "retrieval/no-answer",
        category: "retrieval",
        metric: "no_answer_precision",
        expected: "no results",
      },
      async () => {
        const found = await code.search(fixture.alice, {
          repositoryKey: mainRepositoryKey,
          commitOid: COMMIT_A,
          query: "loreDefinitelyAbsentCodeAwareMarker",
          limit: 5,
        });
        return { passed: found.length === 0, observed: `${found.length} results` };
      },
    ),
  );

  results.push(
    await measure(
      {
        id: "dependencies/imported-call",
        category: "dependencies",
        metric: "dependency_resolution",
        expected: "resolved call caller -> helper",
      },
      async () => {
        const found = await dependencies.query(fixture.alice, {
          repositoryKey: mainRepositoryKey,
          commitOid: COMMIT_A,
          direction: "callees",
          symbol: "caller",
        });
        const edge =
          found.status === "ok"
            ? found.edges.find(
                (candidate) =>
                  candidate.kind === "calls" &&
                  candidate.resolution === "resolved" &&
                  candidate.to?.symbol === "helper",
              )
            : undefined;
        return { passed: Boolean(edge), observed: edge ? "resolved" : found.status };
      },
    ),
    await measure(
      {
        id: "dependencies/unrelated-call-unresolved",
        category: "dependencies",
        metric: "dependency_resolution",
        expected: "unresolved orphanTarget call",
      },
      async () => {
        const found = await dependencies.query(fixture.alice, {
          repositoryKey: mainRepositoryKey,
          commitOid: COMMIT_A,
          direction: "callees",
          symbol: "orphanCaller",
        });
        const edge =
          found.status === "ok"
            ? found.edges.find(
                (candidate) =>
                  candidate.kind === "calls" &&
                  candidate.targetText === "orphanTarget" &&
                  candidate.resolution === "unresolved",
              )
            : undefined;
        return { passed: Boolean(edge), observed: edge ? "unresolved" : found.status };
      },
    ),
  );

  const ambiguousRepositoryKey = "evaluation/code-aware-ambiguous";
  await code.indexRevision(fixture.alice, {
    repositoryKey: ambiguousRepositoryKey,
    displayName: "Ambiguous dependency fixture",
    commitOid: COMMIT_A,
    files: [
      { path: "src/a.ts", content: "export function duplicateHelper() { return 'a'; }\n" },
      { path: "src/b.ts", content: "export function duplicateHelper() { return 'b'; }\n" },
      {
        path: "src/caller.ts",
        content: [
          'import { duplicateHelper } from "./a";',
          'import { duplicateHelper } from "./b";',
          "export function ambiguousCaller() { return duplicateHelper(); }",
        ].join("\n"),
      },
    ],
  });
  results.push(
    await measure(
      {
        id: "dependencies/ambiguous-target",
        category: "dependencies",
        metric: "ambiguity_honesty",
        expected: "ambiguous",
        hardFailure: true,
      },
      async () => {
        const found = await dependencies.query(fixture.alice, {
          repositoryKey: ambiguousRepositoryKey,
          commitOid: COMMIT_A,
          direction: "callees",
          symbol: "ambiguousCaller",
        });
        const ambiguous =
          found.status === "ok"
            ? found.edges.some(
                (edge) => edge.targetText === "duplicateHelper" && edge.resolution === "ambiguous",
              )
            : false;
        return { passed: ambiguous, observed: ambiguous ? "ambiguous" : found.status };
      },
    ),
    await measure(
      {
        id: "dependencies/this-call",
        category: "dependencies",
        metric: "dependency_resolution",
        expected: "resolved Worker.run -> Worker.work",
      },
      async () => {
        const found = await dependencies.query(fixture.alice, {
          repositoryKey: mainRepositoryKey,
          commitOid: COMMIT_A,
          direction: "callees",
          symbol: "Worker.run",
        });
        const resolved =
          found.status === "ok" &&
          found.edges.some(
            (edge) =>
              edge.kind === "calls" &&
              edge.resolution === "resolved" &&
              edge.to?.symbol === "Worker.work",
          );
        return { passed: resolved, observed: resolved ? "resolved" : found.status };
      },
    ),
  );

  const fanoutRepositoryKey = "evaluation/code-aware-fanout";
  await code.indexRevision(fixture.alice, {
    repositoryKey: fanoutRepositoryKey,
    displayName: "Dependency fanout fixture",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/target.ts",
        content: "export function sharedTarget() { return 1; }\n",
      },
      {
        path: "src/callers.ts",
        content: [
          'import { sharedTarget } from "./target";',
          ...Array.from(
            { length: 8 },
            (_, index) => `export function caller${index}() { return sharedTarget(); }`,
          ),
        ].join("\n"),
      },
    ],
  });
  results.push(
    await measure(
      {
        id: "dependencies/fanout-truncation",
        category: "dependencies",
        metric: "dependency_resolution",
        expected: "5 edges and truncated=true",
      },
      async () => {
        const found = await dependencies.query(fixture.alice, {
          repositoryKey: fanoutRepositoryKey,
          commitOid: COMMIT_A,
          direction: "callers",
          symbol: "sharedTarget",
          limit: 5,
        });
        const observed =
          found.status === "ok"
            ? `${found.edges.length} edges, truncated=${found.truncated}`
            : found.status;
        return {
          passed: found.status === "ok" && found.edges.length === 5 && found.truncated,
          observed,
        };
      },
    ),
  );

  const evidenceRepositoryKey = "evaluation/code-evidence";
  const evidenceSource = "export function evidenceAnchor() { return 'safe'; }\n";
  await code.indexRevision(fixture.alice, {
    repositoryKey: evidenceRepositoryKey,
    displayName: "Code evidence fixture",
    commitOid: COMMIT_A,
    files: [{ path: "src/evidence.ts", content: evidenceSource }],
  });
  const evidenceMemory = await memories.remember(fixture.alice, {
    content: "The safety claim is implemented by evidenceAnchor.",
    scope: "private",
  });
  const evidenceArtifacts = await code.search(fixture.alice, {
    repositoryKey: evidenceRepositoryKey,
    commitOid: COMMIT_A,
    query: "evidenceAnchor",
    limit: 5,
  });
  const evidenceArtifact = evidenceArtifacts.find(
    (artifact) => artifact.symbol === "evidenceAnchor",
  );
  if (!evidenceArtifact) throw new Error("Evaluation fixture did not produce evidenceAnchor");
  const citation = await evidence.cite(fixture.alice, {
    memoryId: evidenceMemory.id,
    artifactId: evidenceArtifact.id,
    relationship: "implements",
  });

  results.push(
    await measure(
      {
        id: "evidence/current",
        category: "evidence",
        metric: "stale_classification",
        expected: "current",
        hardFailure: true,
      },
      () => ({
        passed: citation.validationState === "current",
        observed: citation.validationState,
      }),
    ),
  );

  const revisions: Array<{
    commitOid: string;
    files: Array<{ path: string; content: string }>;
    expected: "ambiguous" | "changed" | "deleted" | "moved";
  }> = [
    {
      commitOid: COMMIT_B,
      files: [{ path: "src/moved.ts", content: evidenceSource }],
      expected: "moved",
    },
    {
      commitOid: COMMIT_C,
      files: [
        {
          path: "src/moved.ts",
          content: "export function evidenceAnchor() { return 'changed'; }\n",
        },
      ],
      expected: "changed",
    },
    { commitOid: COMMIT_D, files: [], expected: "deleted" },
    {
      commitOid: COMMIT_E,
      files: [
        { path: "src/copy-a.ts", content: evidenceSource },
        { path: "src/copy-b.ts", content: evidenceSource },
      ],
      expected: "ambiguous",
    },
  ];
  for (const revision of revisions) {
    await code.indexRevision(fixture.alice, {
      repositoryKey: evidenceRepositoryKey,
      displayName: "Code evidence fixture",
      commitOid: revision.commitOid,
      files: revision.files,
    });
    results.push(
      await measure(
        {
          id: `evidence/${revision.expected}`,
          category: "evidence",
          metric: "stale_classification",
          expected: revision.expected,
          hardFailure: true,
        },
        async () => {
          const revalidated = await evidence.revalidate(fixture.alice, {
            evidenceId: citation.id,
            repositoryKey: evidenceRepositoryKey,
            commitOid: revision.commitOid,
          });
          return {
            passed: revalidated.validationState === revision.expected,
            observed: revalidated.validationState,
          };
        },
      ),
    );
  }
  results.push(
    await measure(
      {
        id: "evidence/unverifiable",
        category: "evidence",
        metric: "stale_classification",
        expected: "unverifiable",
        hardFailure: true,
      },
      async () => {
        const revalidated = await evidence.revalidate(fixture.alice, {
          evidenceId: citation.id,
          repositoryKey: evidenceRepositoryKey,
          commitOid: COMMIT_F,
        });
        return {
          passed: revalidated.validationState === "unverifiable",
          observed: revalidated.validationState,
        };
      },
    ),
    await measure(
      {
        id: "evidence/memory-claim-immutable",
        category: "evidence",
        metric: "stale_classification",
        expected: evidenceMemory.content,
        hardFailure: true,
      },
      async () => {
        const current = await memories.retrieve(fixture.alice, evidenceMemory.id);
        return {
          passed: current?.content === evidenceMemory.content,
          observed: current?.content ?? "missing Memory",
        };
      },
    ),
  );

  const proposalContent = "The deployment guard remains the canonical safety check.";
  const proposalArtifacts = await code.search(fixture.alice, {
    repositoryKey: mainRepositoryKey,
    commitOid: COMMIT_A,
    query: "deploymentGuard",
    limit: 5,
  });
  const proposalArtifact = proposalArtifacts.find(
    (artifact) => artifact.symbol === "deploymentGuard",
  );
  if (!proposalArtifact) throw new Error("Evaluation fixture did not produce deploymentGuard");
  const proposal = await memories.propose(fixture.alice, {
    kind: "create",
    content: proposalContent,
    scope: "private",
    codeEvidence: [{ artifactId: proposalArtifact.id, relationship: "supports" }],
  });
  results.push(
    await measure(
      {
        id: "workflow/proposal-noncanonical",
        category: "workflow",
        metric: "workflow_support",
        expected: "proposal absent from Memory retrieval",
      },
      async () => {
        const found = await memories.search(fixture.alice, { query: proposalContent, limit: 10 });
        const proposalVisible = found.some((result) => result.memory.content === proposalContent);
        return {
          passed: !proposalVisible,
          observed: proposalVisible ? "proposal leaked into retrieval" : "absent",
        };
      },
    ),
  );
  const accepted = await memories.reviewProposal(fixture.alice, proposal.id, "accept");
  const acceptedMemory = accepted?.memory;
  results.push(
    await measure(
      {
        id: "workflow/accepted-code-citation",
        category: "workflow",
        metric: "workflow_support",
        expected: "accepted Memory has current typed Code Evidence",
      },
      async () => {
        if (!acceptedMemory) return { passed: false, observed: "proposal was not accepted" };
        const [attached] = await evidence.list(fixture.alice, { memoryId: acceptedMemory.id });
        return {
          passed:
            attached?.validationState === "current" &&
            attached.citedArtifactId === proposalArtifact.id,
          observed: attached?.validationState ?? "missing",
        };
      },
    ),
    await measure(
      {
        id: "workflow/proposal-code-anchor",
        category: "workflow",
        metric: "workflow_support",
        expected: "proposal carries immutable code anchor for human review",
      },
      () => ({
        passed:
          proposal.codeEvidence.length === 1 &&
          proposal.codeEvidence[0]?.citedArtifactId === proposalArtifact.id,
        observed:
          proposal.codeEvidence[0]?.citedArtifactId === proposalArtifact.id
            ? "immutable code anchor present"
            : "missing",
      }),
    ),
  );

  await code.indexRevision(fixture.carol, {
    repositoryKey: mainRepositoryKey,
    displayName: "Forbidden Workspace tripwire",
    commitOid: COMMIT_A,
    files: [
      {
        path: "forbidden/private-tripwire.ts",
        content: "export const deploymentGuard = 'forbidden-workspace';\n",
      },
    ],
  });
  results.push(
    await measure(
      {
        id: "isolation/cross-workspace-search",
        category: "isolation",
        metric: "rls_isolation",
        expected: "no forbidden/private-tripwire.ts",
        hardFailure: true,
      },
      async () => {
        const found = await code.search(fixture.alice, {
          repositoryKey: mainRepositoryKey,
          commitOid: COMMIT_A,
          query: "forbidden-workspace",
          limit: 5,
        });
        const leaked = found.some((artifact) => artifact.path.startsWith("forbidden/"));
        return { passed: !leaked, observed: leaked ? "leaked" : "no results" };
      },
    ),
    await measure(
      {
        id: "isolation/private-memory-evidence",
        category: "isolation",
        metric: "rls_isolation",
        expected: "CodeEvidenceAccessDeniedError",
        hardFailure: true,
      },
      async () => {
        try {
          await evidence.list(fixture.bob, { memoryId: evidenceMemory.id });
          return { passed: false, observed: "private evidence visible" };
        } catch (error) {
          return {
            passed: error instanceof CodeEvidenceAccessDeniedError,
            observed: error instanceof Error ? error.name : String(error),
          };
        }
      },
    ),
  );

  await fixture.suspendMembership(fixture.alice);
  results.push(
    await measure(
      {
        id: "isolation/suspended-search",
        category: "isolation",
        metric: "rls_isolation",
        expected: "no results",
        hardFailure: true,
      },
      async () => {
        const found = await code.search(fixture.alice, {
          repositoryKey: mainRepositoryKey,
          commitOid: COMMIT_A,
          query: "deploymentGuard",
          limit: 5,
        });
        return { passed: found.length === 0, observed: `${found.length} results` };
      },
    ),
    await measure(
      {
        id: "isolation/suspended-dependencies",
        category: "isolation",
        metric: "rls_isolation",
        expected: "not_found",
        hardFailure: true,
      },
      async () => {
        const found = await dependencies.query(fixture.alice, {
          repositoryKey: mainRepositoryKey,
          commitOid: COMMIT_A,
          direction: "callees",
          symbol: "caller",
        });
        return { passed: found.status === "not_found", observed: found.status };
      },
    ),
  );

  return scoreCodeAwareMemoryEvaluation(results);
}
