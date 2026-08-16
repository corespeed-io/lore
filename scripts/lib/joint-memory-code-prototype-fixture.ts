/** PROTOTYPE — scratch-PGlite fixture for joint Memory + Code evaluation. */

import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import type { ActorContext } from "../../src/lib/actor-context";
import {
  type CodeEvidenceAssessment,
  createCodeEvidenceModule,
  type MemoryCodeEvidence,
} from "../../src/lib/code-evidence";
import { createCodeDependencyGraphModule } from "../../src/lib/code-graph";
import { type CodeArtifact, createCodeIndexModule } from "../../src/lib/code-index";
import type { PostgresDatabase } from "../../src/lib/db";
import {
  assembleGroupedJointEvidence,
  assessContextualImpact,
  type DependencyFingerprint,
  type GroupedJointEvidencePacket,
  type JointAnchorEvidence,
  type JointCodeEvidence,
  type JointEvidenceRoute,
  type JointMemoryEvidence,
  planJointEvidenceRoute,
  prioritizeAnchoredMemories,
} from "../../src/lib/joint-memory-code-prototype";
import { createMemoryModule, type Memory } from "../../src/lib/memory";

const OWNER_USER_ID = "10000000-0000-4000-8000-000000000081";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000082";
const OWNER_WORKSPACE_ID = "20000000-0000-4000-8000-000000000081";
const OTHER_WORKSPACE_ID = "20000000-0000-4000-8000-000000000082";
const COMMIT_A = "1".repeat(40);
const COMMIT_B = "2".repeat(40);
const COMMIT_C = "3".repeat(40);
const REPOSITORY_KEY = "evaluation/joint-memory-code-v1";
const migrationsUrl = new URL("../../db/migrations/", import.meta.url);

export type JointPrototypeVariantId =
  | "always-on-union"
  | "code-only"
  | "memory-only"
  | "selective"
  | "selective+anchors"
  | "selective+local-assessment"
  | "selective+contextual-impact";

export interface JointPrototypeVariant {
  id: JointPrototypeVariantId;
  forcedRoute: Exclude<JointEvidenceRoute, "abstain"> | null;
  expandAnchors: boolean;
  assessAnchors: boolean;
  contextualImpact: boolean;
  prioritizeAnchoredMemories: boolean;
}

export interface JointPrototypeCase {
  id: string;
  query: string;
  retrievalQuery: string;
  repositoryKey: string | null;
  commitOid: string | null;
  baseCommitOid: string | null;
  subjectSymbol: string | null;
  expectedRoute: JointEvidenceRoute;
  expectedMemoryKeys: string[];
  expectedCodePaths: string[];
  expectedAnchorState?: MemoryCodeEvidence["validationState"];
  expectedContextualImpact?: "affected" | "possibly_affected" | "unaffected" | "unknown";
  expectedConflict?: string;
}

export interface JointPrototypeCaseResult {
  case: JointPrototypeCase;
  variant: JointPrototypeVariantId;
  packet: GroupedJointEvidencePacket;
  checks: {
    anchorState: boolean | null;
    codeRecall: boolean;
    contextualImpact: boolean | null;
    conflict: boolean | null;
    memoryRecall: boolean;
    memoryTop1: boolean | null;
    noLeakage: boolean;
    route: boolean;
  };
  relevantEvidence: number;
  retrievedEvidence: number;
}

export interface JointPrototypeSession {
  cases: JointPrototypeCase[];
  variants: JointPrototypeVariant[];
  close(): Promise<void>;
  runCase(
    evaluationCase: JointPrototypeCase,
    variant: JointPrototypeVariant,
  ): Promise<JointPrototypeCaseResult>;
}

export const JOINT_PROTOTYPE_VARIANTS: JointPrototypeVariant[] = [
  {
    id: "code-only",
    forcedRoute: "code-only",
    expandAnchors: false,
    assessAnchors: false,
    contextualImpact: false,
    prioritizeAnchoredMemories: false,
  },
  {
    id: "memory-only",
    forcedRoute: "memory-only",
    expandAnchors: false,
    assessAnchors: false,
    contextualImpact: false,
    prioritizeAnchoredMemories: false,
  },
  {
    id: "always-on-union",
    forcedRoute: "both",
    expandAnchors: false,
    assessAnchors: false,
    contextualImpact: false,
    prioritizeAnchoredMemories: false,
  },
  {
    id: "selective",
    forcedRoute: null,
    expandAnchors: false,
    assessAnchors: false,
    contextualImpact: false,
    prioritizeAnchoredMemories: false,
  },
  {
    id: "selective+anchors",
    forcedRoute: null,
    expandAnchors: true,
    assessAnchors: false,
    contextualImpact: false,
    prioritizeAnchoredMemories: true,
  },
  {
    id: "selective+local-assessment",
    forcedRoute: null,
    expandAnchors: true,
    assessAnchors: true,
    contextualImpact: false,
    prioritizeAnchoredMemories: true,
  },
  {
    id: "selective+contextual-impact",
    forcedRoute: null,
    expandAnchors: true,
    assessAnchors: true,
    contextualImpact: true,
    prioritizeAnchoredMemories: true,
  },
];

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const found = new Map<string, T>();
  for (const value of values) found.set(key(value), value);
  return [...found.values()];
}

function anchorMatchesExpectedState(
  anchor: JointAnchorEvidence,
  state: MemoryCodeEvidence["validationState"],
  requestedCommitOid: string | null,
): boolean {
  if (anchor.localState !== state) return false;
  if (state === "unverifiable") {
    return anchor.validatedCommitOid === null && anchor.validatedPath === null;
  }
  if (state === "ambiguous" || state === "deleted") {
    return anchor.validatedCommitOid === requestedCommitOid && anchor.validatedPath === null;
  }
  return anchor.validatedCommitOid === requestedCommitOid && anchor.validatedPath !== null;
}

function codeEvidence(artifact: CodeArtifact): JointCodeEvidence {
  return {
    artifactId: artifact.id,
    commitOid: artifact.commitOid,
    content: artifact.content,
    contentSha256: artifact.contentSha256,
    path: artifact.path,
    score: artifact.score,
    symbol: artifact.symbol,
  };
}

function anchorEvidence(
  evidence: MemoryCodeEvidence,
  assessment: CodeEvidenceAssessment | null = null,
): JointAnchorEvidence {
  return {
    id: evidence.id,
    memoryId: evidence.memoryId,
    relationship: evidence.relationship,
    localState: assessment?.validationState ?? evidence.validationState,
    citedCommitOid: evidence.citedCommitOid,
    citedPath: evidence.citedPath,
    citedDeclarationChunkOrdinal: evidence.citedDeclarationChunkOrdinal,
    citedDeclarationContextSha256: evidence.citedDeclarationContextSha256,
    validatedCommitOid: assessment ? assessment.validatedCommitOid : evidence.validatedCommitOid,
    validatedPath: assessment ? assessment.validatedPath : evidence.validatedPath,
  };
}

async function artifactFor(
  code: ReturnType<typeof createCodeIndexModule>,
  actor: ActorContext,
  commitOid: string,
  symbol: string,
): Promise<CodeArtifact> {
  const artifacts = await code.search(actor, {
    repositoryKey: REPOSITORY_KEY,
    commitOid,
    query: symbol,
    limit: 20,
  });
  const artifact = artifacts.find((candidate) => candidate.symbol === symbol);
  if (!artifact) throw new Error(`Fixture artifact ${symbol} at ${commitOid} was not indexed`);
  return artifact;
}

async function dependencyFingerprints(input: {
  actor: ActorContext;
  code: ReturnType<typeof createCodeIndexModule>;
  dependencies: ReturnType<typeof createCodeDependencyGraphModule>;
  commitOid: string;
  symbol: string;
}): Promise<{ fingerprints: DependencyFingerprint[]; truncated: boolean }> {
  const result = await input.dependencies.query(input.actor, {
    repositoryKey: REPOSITORY_KEY,
    commitOid: input.commitOid,
    direction: "callees",
    symbol: input.symbol,
    limit: 50,
  });
  if (result.status !== "ok") {
    return {
      fingerprints: [
        {
          kind: "subject",
          resolution: result.status === "ambiguous" ? "ambiguous" : "unresolved",
          targetKey: input.symbol,
          contentSha256: null,
        },
      ],
      truncated: false,
    };
  }

  const fingerprints: DependencyFingerprint[] = [];
  for (const edge of result.edges) {
    let contentSha256: string | null = null;
    if (edge.resolution === "resolved" && edge.to.artifactId) {
      const query = edge.to.symbol ?? edge.to.path ?? edge.targetText;
      const candidates = await input.code.search(input.actor, {
        repositoryKey: REPOSITORY_KEY,
        commitOid: input.commitOid,
        query,
        limit: 20,
      });
      contentSha256 =
        candidates.find((candidate) => candidate.id === edge.to.artifactId)?.contentSha256 ?? null;
    }
    fingerprints.push({
      kind: edge.kind,
      resolution: edge.resolution,
      targetKey: edge.to.symbolKey ?? edge.to.symbol ?? edge.targetText,
      contentSha256,
    });
  }
  return { fingerprints, truncated: result.truncated };
}

async function bootstrapDatabase(): Promise<{
  actor: ActorContext;
  database: PostgresDatabase;
  forbiddenActor: ActorContext;
  postgres: PGlite;
}> {
  const postgres = new PGlite({ extensions: { pg_trgm, vector } });
  await postgres.waitReady;
  const migrationIds = (await readdir(migrationsUrl))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const migrationId of migrationIds) {
    await postgres.exec(await readFile(new URL(migrationId, migrationsUrl), "utf8"));
  }
  await postgres.query("INSERT INTO users (id, display_name) VALUES ($1, $2), ($3, $4)", [
    OWNER_USER_ID,
    "Joint Evaluation Owner",
    OTHER_USER_ID,
    "Joint Evaluation Other",
  ]);
  await postgres.query("INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)", [
    OWNER_WORKSPACE_ID,
    "Joint Evaluation Visible",
    OTHER_WORKSPACE_ID,
    "Joint Evaluation Forbidden",
  ]);
  await postgres.query(
    `INSERT INTO memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
    [OWNER_WORKSPACE_ID, OWNER_USER_ID, OTHER_WORKSPACE_ID, OTHER_USER_ID],
  );
  await postgres.exec("SET ROLE lore_app");

  const database: PostgresDatabase = {
    transaction: (use) =>
      postgres.transaction(async (transaction) => {
        await transaction.query("SET LOCAL ROLE lore_app");
        return use({ query: (sql, params) => transaction.query(sql, params) });
      }),
  };
  return {
    actor: { workspaceId: OWNER_WORKSPACE_ID, userId: OWNER_USER_ID },
    database,
    forbiddenActor: { workspaceId: OTHER_WORKSPACE_ID, userId: OTHER_USER_ID },
    postgres,
  };
}

export async function createJointMemoryCodePrototypeSession(): Promise<JointPrototypeSession> {
  const { actor, database, forbiddenActor, postgres } = await bootstrapDatabase();
  const code = createCodeIndexModule(database);
  const dependencies = createCodeDependencyGraphModule(database);
  const evidence = createCodeEvidenceModule(database);
  const memories = createMemoryModule(database);

  const revisionA = [
    {
      path: "src/security/guard.ts",
      content: "export function deploymentGuard() { return 'fail-closed'; }\n",
    },
    {
      path: "src/network/timeout.ts",
      content: "export function requestTimeout() { return 5000; }\n",
    },
    {
      path: "src/auth/authorize.ts",
      content: [
        'import { checkPolicy } from "./policy";',
        "export function authorizeRequest() { return checkPolicy(); }",
      ].join("\n"),
    },
    {
      path: "src/auth/policy.ts",
      content: "export function checkPolicy() { return 'strict'; }\n",
    },
    {
      path: "src/pipeline.ts",
      content: "export const exactPipelineMarker = (value: string) => value.trim();\n",
    },
    {
      path: "src/legacy/removed.ts",
      content: "export function removedFeature() { return 'legacy'; }\n",
    },
    {
      path: "src/duplicate.ts",
      content: "export function duplicateTarget() { return 'same'; }\n",
    },
    {
      path: "src/mode.ts",
      content: "export function modeSwitch() { return 'enabled'; }\n",
    },
  ];
  const revisionB = [
    {
      path: "src/runtime/guard.ts",
      content: "export function deploymentGuard() { return 'fail-closed'; }\n",
    },
    {
      path: "src/network/timeout.ts",
      content: "export function requestTimeout() { return 3000; }\n",
    },
    {
      path: "src/auth/authorize.ts",
      content: [
        'import { checkPolicy } from "./policy";',
        "export function authorizeRequest() { return checkPolicy(); }",
      ].join("\n"),
    },
    {
      path: "src/auth/policy.ts",
      content: "export function checkPolicy() { return 'role-aware'; }\n",
    },
    {
      path: "src/pipeline.ts",
      content: "export const exactPipelineMarker = (value: string) => value.trim();\n",
    },
    {
      path: "src/duplicates/a.ts",
      content: "export function duplicateTarget() { return 'same'; }\n",
    },
    {
      path: "src/duplicates/b.ts",
      content: "export function duplicateTarget() { return 'same'; }\n",
    },
    {
      path: "src/mode.ts",
      content: "export function modeSwitch() { return 'enabled'; }\n",
    },
  ];
  await code.indexRevision(actor, {
    repositoryKey: REPOSITORY_KEY,
    displayName: "Joint Memory Code Evaluation",
    commitOid: COMMIT_A,
    files: revisionA,
  });
  await code.indexRevision(actor, {
    repositoryKey: REPOSITORY_KEY,
    displayName: "Joint Memory Code Evaluation",
    commitOid: COMMIT_B,
    files: revisionB,
  });
  await code.indexRevision(forbiddenActor, {
    repositoryKey: REPOSITORY_KEY,
    displayName: "Forbidden Joint Evaluation",
    commitOid: COMMIT_B,
    files: [
      {
        path: "forbidden/private.ts",
        content: "export const deploymentGuard = 'forbidden-joint-tripwire';\n",
      },
    ],
  });

  const memoryByKey = new Map<string, Memory>();
  async function remember(key: string, content: string, currentActor = actor): Promise<Memory> {
    const memory = await memories.remember(currentActor, {
      content,
      metadata: { evaluationKey: key },
      scope: "shared",
    });
    if (currentActor === actor) memoryByKey.set(key, memory);
    return memory;
  }

  const guardMemory = await remember(
    "guard-rationale",
    "Decision GUARD-1: deploymentGuard was designed fail closed so an unavailable policy cannot grant production access.",
  );
  const timeoutMemory = await remember(
    "timeout-history",
    "Historical decision TIMEOUT-7: requestTimeout was set to 5000 milliseconds for the first network rollout.",
  );
  const authorizationMemory = await remember(
    "authorization-rationale",
    "Decision AUTH-9: authorizeRequest delegates to checkPolicy and assumes that policy remains strict.",
  );
  const removedMemory = await remember(
    "removed-history",
    "Historical decision REMOVE-3: removedFeature provided the legacy compatibility path.",
  );
  const duplicateMemory = await remember(
    "duplicate-history",
    "Historical decision DUP-4: duplicateTarget had one authoritative implementation.",
  );
  const unavailableMemory = await remember(
    "unavailable-revision-history",
    "Historical decision PIPE-5: exactPipelineMarker trims pipeline input before dispatch.",
  );
  const contradictionMemory = await remember(
    "mode-contradiction",
    "Decision MODE-6: modeSwitch should remain disabled in every deployment.",
  );
  await remember(
    "personal-preference",
    "Personal preference: remember that the owner prefers dark mode for development tools.",
  );
  await remember(
    "guard-distractor",
    "Historical formatting note: deploymentGuard naming appeared in an unrelated style discussion.",
  );
  await remember(
    "forbidden-tripwire",
    "Decision GUARD-1 forbidden-joint-tripwire deploymentGuard private workspace secret.",
    forbiddenActor,
  );

  await evidence.cite(actor, {
    memoryId: guardMemory.id,
    artifactId: (await artifactFor(code, actor, COMMIT_A, "deploymentGuard")).id,
    relationship: "rationale",
  });
  await evidence.cite(actor, {
    memoryId: timeoutMemory.id,
    artifactId: (await artifactFor(code, actor, COMMIT_A, "requestTimeout")).id,
    relationship: "supports",
  });
  await evidence.cite(actor, {
    memoryId: removedMemory.id,
    artifactId: (await artifactFor(code, actor, COMMIT_A, "removedFeature")).id,
    relationship: "supports",
  });
  await evidence.cite(actor, {
    memoryId: duplicateMemory.id,
    artifactId: (await artifactFor(code, actor, COMMIT_A, "duplicateTarget")).id,
    relationship: "supports",
  });
  await evidence.cite(actor, {
    memoryId: unavailableMemory.id,
    artifactId: (await artifactFor(code, actor, COMMIT_A, "exactPipelineMarker")).id,
    relationship: "supports",
  });
  await evidence.cite(actor, {
    memoryId: contradictionMemory.id,
    artifactId: (await artifactFor(code, actor, COMMIT_A, "modeSwitch")).id,
    relationship: "contradicts",
  });
  await evidence.cite(actor, {
    memoryId: authorizationMemory.id,
    artifactId: (await artifactFor(code, actor, COMMIT_A, "authorizeRequest")).id,
    relationship: "supports",
  });

  const cases: JointPrototypeCase[] = [
    {
      id: "rationale/moved-guard",
      query: "Why was deploymentGuard designed fail closed?",
      retrievalQuery: "deploymentGuard",
      repositoryKey: REPOSITORY_KEY,
      commitOid: COMMIT_B,
      baseCommitOid: COMMIT_A,
      subjectSymbol: "deploymentGuard",
      expectedRoute: "both",
      expectedMemoryKeys: ["guard-rationale"],
      expectedCodePaths: ["src/runtime/guard.ts"],
      expectedAnchorState: "moved",
    },
    {
      id: "current/code-only-timeout",
      query: "Where is requestTimeout implemented now?",
      retrievalQuery: "requestTimeout",
      repositoryKey: REPOSITORY_KEY,
      commitOid: COMMIT_B,
      baseCommitOid: COMMIT_A,
      subjectSymbol: "requestTimeout",
      expectedRoute: "code-only",
      expectedMemoryKeys: [],
      expectedCodePaths: ["src/network/timeout.ts"],
    },
    {
      id: "change/local-timeout",
      query: "What changed about requestTimeout since the historical decision?",
      retrievalQuery: "requestTimeout",
      repositoryKey: REPOSITORY_KEY,
      commitOid: COMMIT_B,
      baseCommitOid: COMMIT_A,
      subjectSymbol: "requestTimeout",
      expectedRoute: "both",
      expectedMemoryKeys: ["timeout-history"],
      expectedCodePaths: ["src/network/timeout.ts"],
      expectedAnchorState: "changed",
      expectedContextualImpact: "unaffected",
    },
    {
      id: "change/transitive-policy",
      query: "Is authorizeRequest still consistent with the decision after dependency change?",
      retrievalQuery: "authorizeRequest",
      repositoryKey: REPOSITORY_KEY,
      commitOid: COMMIT_B,
      baseCommitOid: COMMIT_A,
      subjectSymbol: "authorizeRequest",
      expectedRoute: "both",
      expectedMemoryKeys: ["authorization-rationale"],
      expectedCodePaths: ["src/auth/authorize.ts"],
      expectedAnchorState: "current",
      expectedContextualImpact: "affected",
    },
    {
      id: "blast-radius/policy",
      query: "What is the dependency impact of authorizeRequest?",
      retrievalQuery: "authorizeRequest",
      repositoryKey: REPOSITORY_KEY,
      commitOid: COMMIT_B,
      baseCommitOid: COMMIT_A,
      subjectSymbol: "authorizeRequest",
      expectedRoute: "code-only",
      expectedMemoryKeys: [],
      expectedCodePaths: ["src/auth/authorize.ts"],
      expectedContextualImpact: "affected",
    },
    {
      id: "change/deleted-feature",
      query: "What changed about removedFeature since the historical decision?",
      retrievalQuery: "removedFeature",
      repositoryKey: REPOSITORY_KEY,
      commitOid: COMMIT_B,
      baseCommitOid: COMMIT_A,
      subjectSymbol: null,
      expectedRoute: "both",
      expectedMemoryKeys: ["removed-history"],
      expectedCodePaths: [],
      expectedAnchorState: "deleted",
      expectedConflict: "deleted",
    },
    {
      id: "change/ambiguous-duplicate",
      query: "What changed about duplicateTarget since the historical decision?",
      retrievalQuery: "duplicateTarget",
      repositoryKey: REPOSITORY_KEY,
      commitOid: COMMIT_B,
      baseCommitOid: COMMIT_A,
      subjectSymbol: null,
      expectedRoute: "both",
      expectedMemoryKeys: ["duplicate-history"],
      expectedCodePaths: ["src/duplicates/a.ts", "src/duplicates/b.ts"],
      expectedAnchorState: "ambiguous",
      expectedConflict: "ambiguous",
    },
    {
      id: "change/unverifiable-revision",
      query: "What changed about exactPipelineMarker in the unavailable revision?",
      retrievalQuery: "exactPipelineMarker",
      repositoryKey: REPOSITORY_KEY,
      commitOid: COMMIT_C,
      baseCommitOid: COMMIT_A,
      subjectSymbol: null,
      expectedRoute: "both",
      expectedMemoryKeys: ["unavailable-revision-history"],
      expectedCodePaths: [],
      expectedAnchorState: "unverifiable",
      expectedConflict: "unverifiable",
    },
    {
      id: "rationale/explicit-contradiction",
      query: "Why was modeSwitch designed to remain disabled?",
      retrievalQuery: "modeSwitch",
      repositoryKey: REPOSITORY_KEY,
      commitOid: COMMIT_B,
      baseCommitOid: COMMIT_A,
      subjectSymbol: "modeSwitch",
      expectedRoute: "both",
      expectedMemoryKeys: ["mode-contradiction"],
      expectedCodePaths: ["src/mode.ts"],
      expectedAnchorState: "current",
      expectedConflict: "contradicts",
    },
    {
      id: "memory/personal-preference",
      query: "Remember my personal preference for dark mode",
      retrievalQuery: "dark mode",
      repositoryKey: null,
      commitOid: null,
      baseCommitOid: null,
      subjectSymbol: null,
      expectedRoute: "memory-only",
      expectedMemoryKeys: ["personal-preference"],
      expectedCodePaths: [],
    },
    {
      id: "current/exact-symbol",
      query: "Find symbol exactPipelineMarker",
      retrievalQuery: "exactPipelineMarker",
      repositoryKey: REPOSITORY_KEY,
      commitOid: COMMIT_B,
      baseCommitOid: COMMIT_A,
      subjectSymbol: "exactPipelineMarker",
      expectedRoute: "code-only",
      expectedMemoryKeys: [],
      expectedCodePaths: ["src/pipeline.ts"],
    },
    {
      id: "no-answer/code",
      query: "Where is definitelyAbsentJointSymbol?",
      retrievalQuery: "definitelyAbsentJointSymbol",
      repositoryKey: REPOSITORY_KEY,
      commitOid: COMMIT_B,
      baseCommitOid: COMMIT_A,
      subjectSymbol: "definitelyAbsentJointSymbol",
      expectedRoute: "code-only",
      expectedMemoryKeys: [],
      expectedCodePaths: [],
    },
    {
      id: "neutral/abstain",
      query: "Tell me something interesting",
      retrievalQuery: "something interesting",
      repositoryKey: REPOSITORY_KEY,
      commitOid: COMMIT_B,
      baseCommitOid: COMMIT_A,
      subjectSymbol: null,
      expectedRoute: "abstain",
      expectedMemoryKeys: [],
      expectedCodePaths: [],
    },
  ];

  return {
    cases,
    variants: JOINT_PROTOTYPE_VARIANTS,
    close: () => postgres.close(),
    async runCase(evaluationCase, variant) {
      const basePlan = planJointEvidenceRoute({
        query: evaluationCase.query,
        hasRepositoryContext: Boolean(evaluationCase.repositoryKey && evaluationCase.commitOid),
      });
      const plan = {
        ...basePlan,
        route: variant.forcedRoute ?? basePlan.route,
        needsAnchorExpansion: variant.expandAnchors && basePlan.route === "both",
        needsLocalAssessment:
          variant.assessAnchors && basePlan.route === "both" && Boolean(evaluationCase.commitOid),
        needsContextualImpact:
          variant.contextualImpact &&
          basePlan.needsContextualImpact &&
          Boolean(evaluationCase.baseCommitOid && evaluationCase.commitOid),
        reasons: [...basePlan.reasons, `ablation:${variant.id}`],
      };

      const memoryResults =
        plan.route === "memory-only" || plan.route === "both"
          ? await memories.search(actor, { query: evaluationCase.retrievalQuery, limit: 5 })
          : [];
      const jointMemories: JointMemoryEvidence[] = memoryResults.map((result) => ({
        id: result.memory.id,
        content: result.memory.content,
        score: result.score,
      }));
      const directArtifacts =
        (plan.route === "code-only" || plan.route === "both") &&
        evaluationCase.repositoryKey &&
        evaluationCase.commitOid
          ? await code.search(actor, {
              repositoryKey: evaluationCase.repositoryKey,
              commitOid: evaluationCase.commitOid,
              query: evaluationCase.retrievalQuery,
              limit: 8,
            })
          : [];
      const jointCode = directArtifacts.map(codeEvidence);
      const jointAnchors: JointAnchorEvidence[] = [];

      if (plan.needsAnchorExpansion && evaluationCase.repositoryKey) {
        for (const result of memoryResults) {
          const attached = await evidence.list(actor, { memoryId: result.memory.id });
          for (const original of attached) {
            const assessment =
              plan.needsLocalAssessment && evaluationCase.commitOid
                ? await evidence.assess(actor, {
                    evidenceId: original.id,
                    repositoryKey: evaluationCase.repositoryKey,
                    commitOid: evaluationCase.commitOid,
                  })
                : null;
            jointAnchors.push(anchorEvidence(original, assessment));
            const targetQuery =
              (assessment ? assessment.validatedPath : original.validatedPath) ??
              original.citedPath;
            if (evaluationCase.commitOid) {
              const expanded = await code.search(actor, {
                repositoryKey: evaluationCase.repositoryKey,
                commitOid: evaluationCase.commitOid,
                query: targetQuery,
                limit: 8,
              });
              jointCode.push(...expanded.map(codeEvidence));
            }
          }
        }
      }

      let contextualImpact = null;
      if (
        plan.needsContextualImpact &&
        evaluationCase.baseCommitOid &&
        evaluationCase.commitOid &&
        evaluationCase.subjectSymbol
      ) {
        const before = await dependencyFingerprints({
          actor,
          code,
          dependencies,
          commitOid: evaluationCase.baseCommitOid,
          symbol: evaluationCase.subjectSymbol,
        });
        const after = await dependencyFingerprints({
          actor,
          code,
          dependencies,
          commitOid: evaluationCase.commitOid,
          symbol: evaluationCase.subjectSymbol,
        });
        contextualImpact = assessContextualImpact(before.fingerprints, after.fingerprints, {
          beforeTruncated: before.truncated,
          afterTruncated: after.truncated,
        });
      }

      const distinctMemories = uniqueBy(jointMemories, (candidate) => candidate.id);
      const distinctAnchors = uniqueBy(jointAnchors, (candidate) => candidate.id);
      const packet = assembleGroupedJointEvidence({
        query: evaluationCase.query,
        plan,
        memories: variant.prioritizeAnchoredMemories
          ? prioritizeAnchoredMemories(distinctMemories, distinctAnchors)
          : distinctMemories,
        code: uniqueBy(jointCode, (candidate) => candidate.artifactId),
        anchors: distinctAnchors,
        requestedCommitOid: evaluationCase.commitOid,
        contextualImpact,
      });
      const returnedMemoryKeysInOrder = packet.memories.flatMap((candidate) => {
        const matched = [...memoryByKey.entries()].find(([, memory]) => memory.id === candidate.id);
        return matched ? [matched[0]] : [];
      });
      const returnedMemoryKeys = new Set(returnedMemoryKeysInOrder);
      const expectedArtifactPaths = new Set(evaluationCase.expectedCodePaths);
      const relevantMemoryCount = evaluationCase.expectedMemoryKeys.filter((key) =>
        returnedMemoryKeys.has(key),
      ).length;
      const relevantCodeCount = uniqueBy(
        packet.code.filter((candidate) => expectedArtifactPaths.has(candidate.path)),
        (candidate) => candidate.path,
      ).length;
      const retrievedEvidence =
        packet.memories.length + uniqueBy(packet.code, (candidate) => candidate.path).length;
      const noLeakage =
        !packet.memories.some((candidate) =>
          candidate.content.includes("forbidden-joint-tripwire"),
        ) && !packet.code.some((candidate) => candidate.path.startsWith("forbidden/"));
      return {
        case: evaluationCase,
        variant: variant.id,
        packet,
        checks: {
          route: plan.route === evaluationCase.expectedRoute,
          memoryRecall: evaluationCase.expectedMemoryKeys.every((key) =>
            returnedMemoryKeys.has(key),
          ),
          memoryTop1: evaluationCase.expectedMemoryKeys.length
            ? evaluationCase.expectedMemoryKeys.includes(returnedMemoryKeysInOrder[0] ?? "")
            : null,
          codeRecall: evaluationCase.expectedCodePaths.every((path) =>
            packet.code.some((candidate) => candidate.path === path),
          ),
          anchorState: evaluationCase.expectedAnchorState
            ? packet.anchors.some((candidate) =>
                anchorMatchesExpectedState(
                  candidate,
                  evaluationCase.expectedAnchorState as MemoryCodeEvidence["validationState"],
                  evaluationCase.commitOid,
                ),
              )
            : null,
          contextualImpact: evaluationCase.expectedContextualImpact
            ? packet.receipt.contextualImpact?.state === evaluationCase.expectedContextualImpact
            : null,
          conflict: evaluationCase.expectedConflict
            ? packet.conflicts.some((conflict) =>
                conflict.includes(evaluationCase.expectedConflict ?? ""),
              )
            : null,
          noLeakage,
        },
        relevantEvidence: relevantMemoryCount + relevantCodeCount,
        retrievedEvidence,
      };
    },
  };
}
