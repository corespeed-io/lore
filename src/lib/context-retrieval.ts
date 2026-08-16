import type { ActorContext } from "./actor-context";
import {
  type CodeEvidenceRelationship,
  type CodeEvidenceValidationState,
  createCodeEvidenceModule,
  type MemoryCodeEvidence,
} from "./code-evidence";
import { createCodeDependencyGraphModule } from "./code-graph";
import { createCodeIndexReadModule } from "./code-index-read";
import type { PostgresDatabase } from "./db";
import {
  assessContextualImpact,
  type ContextualImpactAssessment,
  type DependencyFingerprint,
  type JointEvidenceIntent,
  type JointEvidenceRoute,
  planJointEvidenceRoute,
} from "./joint-memory-code";
import { createMemoryModule, type MemoryModuleOptions, type MemoryScope } from "./memory";

export const CONTEXT_RETRIEVAL_REVISION = "joint-memory-code-v2";

export type ContextRetrievalRoute = "auto" | "both" | "code-only" | "memory-only";

export interface RetrieveContextInput {
  query: string;
  memoryQuery?: string;
  codeQuery?: string;
  repositoryKey?: string;
  commitOid?: string;
  route?: ContextRetrievalRoute;
  memoryLimit?: number;
  codeLimit?: number;
  scope?: MemoryScope;
  metadata?: Record<string, unknown>;
  pathPrefix?: string;
}

export interface RetrievedMemoryContext {
  id: string;
  scope: MemoryScope;
  updatedAt: string;
  score: number;
  rerankScore?: number;
  evidence: string;
}

export interface RetrievedCodeContext {
  artifactId: string;
  commitOid: string;
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  score: number;
  matchedChannels: Array<"symbol" | "literal" | "lexical" | "path">;
  content: string;
}

export interface RetrievedAnchorContext {
  id: string;
  memoryId: string;
  relationship: CodeEvidenceRelationship;
  localState: CodeEvidenceValidationState;
  citedCommitOid: string;
  citedPath: string;
  validatedCommitOid: string | null;
  validatedPath: string | null;
}

export interface RetrievedContext {
  revision: string;
  query: string;
  plan: {
    intent: JointEvidenceIntent;
    route: JointEvidenceRoute;
    needsAnchorExpansion: boolean;
    needsContextualImpact: boolean;
    needsLocalAssessment: boolean;
    reasons: string[];
  };
  deliveredRoute: JointEvidenceRoute;
  memories: RetrievedMemoryContext[];
  code: RetrievedCodeContext[];
  anchors: RetrievedAnchorContext[];
  conflicts: string[];
  receipt: {
    memoryCandidates: number;
    codeCandidates: number;
    anchorCandidates: number;
    requestedCommitOid: string | null;
    memoryQuery: string | null;
    codeQuery: string | null;
    contextualImpact: ContextualImpactAssessment | null;
  };
}

export interface ContextRetrievalModule {
  retrieve(actor: ActorContext, input: RetrieveContextInput): Promise<RetrievedContext>;
}

export class ContextRetrievalValidationError extends Error {
  override name = "ContextRetrievalValidationError";
  readonly status = 400;
}

const CONTEXTUAL_ANCHOR_LIMIT = 5;
const CONTEXTUAL_EDGE_LIMIT = 25;

type DependencySubject = { path: string } | { symbol: string };

function dependencySubject(citation: MemoryCodeEvidence, path: string): DependencySubject {
  if (!citation.citedSymbolKey) return { path };
  const separator = citation.citedSymbolKey.indexOf("#");
  return {
    symbol:
      separator < 0
        ? citation.citedSymbolKey
        : `${path}${citation.citedSymbolKey.slice(separator)}`,
  };
}

async function dependencyFingerprints(input: {
  actor: ActorContext;
  code: ReturnType<typeof createCodeIndexReadModule>;
  dependencies: ReturnType<typeof createCodeDependencyGraphModule>;
  repositoryKey: string;
  commitOid: string;
  subject: DependencySubject;
}): Promise<{ fingerprints: DependencyFingerprint[]; truncated: boolean }> {
  const result = await input.dependencies.query(input.actor, {
    repositoryKey: input.repositoryKey,
    commitOid: input.commitOid,
    direction: "callees",
    ...input.subject,
    limit: CONTEXTUAL_EDGE_LIMIT,
  });
  const subjectKey = "symbol" in input.subject ? input.subject.symbol : input.subject.path;
  if (result.status !== "ok") {
    return {
      fingerprints: [
        {
          kind: "subject",
          resolution: result.status === "ambiguous" ? "ambiguous" : "unresolved",
          targetKey: subjectKey,
          contentSha256: null,
        },
      ],
      truncated: result.status === "ambiguous" ? result.truncated : false,
    };
  }
  const targetArtifactIds = [
    ...new Set(
      result.edges.flatMap((edge) =>
        edge.resolution === "resolved" && edge.to.artifactId ? [edge.to.artifactId] : [],
      ),
    ),
  ];
  const targetDigests = targetArtifactIds.length
    ? await input.code.getArtifactLogicalDigests(input.actor, {
        repositoryKey: input.repositoryKey,
        commitOid: input.commitOid,
        artifactIds: targetArtifactIds,
      })
    : [];
  const contentByArtifactId = new Map(
    targetDigests.map((artifact) => [artifact.artifactId, artifact.fingerprintSha256]),
  );
  return {
    fingerprints: result.edges.map((edge) => ({
      kind: edge.kind,
      resolution: edge.resolution,
      targetKey: edge.to.symbolKey ?? edge.to.path ?? edge.to.symbol ?? edge.targetText,
      contentSha256: edge.to.artifactId
        ? (contentByArtifactId.get(edge.to.artifactId) ?? null)
        : null,
    })),
    truncated: result.truncated,
  };
}

function aggregateContextualImpact(
  assessments: readonly { anchorId: string; assessment: ContextualImpactAssessment }[],
  truncated: boolean,
): ContextualImpactAssessment {
  const changes = assessments.flatMap(({ anchorId, assessment }) =>
    assessment.changes.map((change) => `anchor:${anchorId}:${change}`),
  );
  if (truncated) changes.push("anchors:truncated");
  const states = new Set(assessments.map(({ assessment }) => assessment.state));
  if (states.has("affected")) return { state: "affected", changes };
  if (states.has("possibly_affected")) return { state: "possibly_affected", changes };
  if (truncated || states.has("unknown") || assessments.length === 0) {
    return {
      state: "unknown",
      changes:
        changes.length > 0
          ? changes
          : assessments.length === 0
            ? ["not_assessed:no_resolvable_anchor_subject"]
            : ["assessment:unknown"],
    };
  }
  return { state: "unaffected", changes };
}

function text(value: string, name: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || hasControlCharacters(normalized)) {
    throw new ContextRetrievalValidationError(`${name} is invalid`);
  }
  return normalized;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function commitOid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(normalized)) {
    throw new ContextRetrievalValidationError(
      "commitOid must be a full 40- or 64-character Git OID",
    );
  }
  return normalized;
}

function limit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new ContextRetrievalValidationError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return normalized;
}

function deliveredRoute(memoryCount: number, codeCount: number, planned: JointEvidenceRoute) {
  if (memoryCount > 0 && codeCount > 0) return "both" as const;
  if (memoryCount > 0) return "memory-only" as const;
  if (codeCount > 0) return "code-only" as const;
  return planned === "abstain" ? planned : ("abstain" as const);
}

export function createContextRetrievalModule(
  database: PostgresDatabase,
  memoryOptions: MemoryModuleOptions = {},
): ContextRetrievalModule {
  const memories = createMemoryModule(database, memoryOptions);
  const code = createCodeIndexReadModule(database);
  const dependencies = createCodeDependencyGraphModule(database);
  const evidence = createCodeEvidenceModule(database);

  return {
    async retrieve(actor, input) {
      const query = text(input.query, "query", 10_000);
      const repositoryKey =
        input.repositoryKey === undefined
          ? undefined
          : text(input.repositoryKey, "repositoryKey", 512);
      const requestedCommitOid =
        input.commitOid === undefined ? undefined : commitOid(input.commitOid);
      if ((repositoryKey === undefined) !== (requestedCommitOid === undefined)) {
        throw new ContextRetrievalValidationError(
          "repositoryKey and commitOid must be provided together",
        );
      }
      const route = input.route ?? "auto";
      if (!(["auto", "both", "code-only", "memory-only"] as const).includes(route)) {
        throw new ContextRetrievalValidationError("route is invalid");
      }
      if ((route === "both" || route === "code-only") && repositoryKey === undefined) {
        throw new ContextRetrievalValidationError(`${route} requires repositoryKey and commitOid`);
      }
      if (input.pathPrefix !== undefined && repositoryKey === undefined) {
        throw new ContextRetrievalValidationError(
          "pathPrefix requires repositoryKey and commitOid",
        );
      }
      if (input.codeQuery !== undefined && repositoryKey === undefined) {
        throw new ContextRetrievalValidationError("codeQuery requires repositoryKey and commitOid");
      }
      const memoryLimit = limit(input.memoryLimit, 5, 10, "memoryLimit");
      const codeLimit = limit(input.codeLimit, 10, 20, "codeLimit");
      const plan = planJointEvidenceRoute({
        query,
        hasRepositoryContext: repositoryKey !== undefined,
        route,
      });
      const memoryQuery =
        plan.route === "memory-only" || plan.route === "both"
          ? text(input.memoryQuery ?? query, "memoryQuery", 10_000)
          : null;
      const codeQuery =
        plan.route === "code-only" || plan.route === "both"
          ? text(input.codeQuery ?? query, "codeQuery", 2_000)
          : null;
      const [memoryResults, codeResults] = await Promise.all([
        memoryQuery !== null
          ? memories.search(actor, {
              query: memoryQuery,
              limit: memoryLimit,
              scope: input.scope,
              metadataFilter: input.metadata,
            })
          : [],
        codeQuery !== null && repositoryKey !== undefined && requestedCommitOid !== undefined
          ? code.search(actor, {
              repositoryKey,
              commitOid: requestedCommitOid,
              query: codeQuery,
              limit: codeLimit,
              pathPrefix: input.pathPrefix,
            })
          : [],
      ]);

      const anchors: RetrievedAnchorContext[] = [];
      const anchoredArtifactIds: string[] = [];
      const contextualSubjects: Array<{
        anchorId: string;
        baseCommitOid: string;
        beforeSubject: DependencySubject;
        afterSubject: DependencySubject;
      }> = [];
      if (
        plan.needsAnchorExpansion &&
        plan.needsLocalAssessment &&
        repositoryKey !== undefined &&
        requestedCommitOid !== undefined
      ) {
        for (const result of memoryResults) {
          const citations = await evidence.list(actor, { memoryId: result.memory.id });
          for (const citation of citations) {
            if (anchors.length >= 25) break;
            const assessment = await evidence.assess(actor, {
              evidenceId: citation.id,
              repositoryKey,
              commitOid: requestedCommitOid,
            });
            anchors.push({
              id: citation.id,
              memoryId: citation.memoryId,
              relationship: citation.relationship,
              localState: assessment.validationState,
              citedCommitOid: citation.citedCommitOid,
              citedPath: citation.citedPath,
              validatedCommitOid: assessment.validatedCommitOid,
              validatedPath: assessment.validatedPath,
            });
            if (
              assessment.validatedArtifactId &&
              !anchoredArtifactIds.includes(assessment.validatedArtifactId)
            ) {
              anchoredArtifactIds.push(assessment.validatedArtifactId);
            }
            if (assessment.validatedRevisionId) {
              contextualSubjects.push({
                anchorId: citation.id,
                baseCommitOid: citation.citedCommitOid,
                beforeSubject: dependencySubject(citation, citation.citedPath),
                afterSubject: dependencySubject(
                  citation,
                  assessment.validatedPath ?? citation.citedPath,
                ),
              });
            }
          }
          if (anchors.length >= 25) break;
        }
      }

      const anchoredArtifacts =
        anchoredArtifactIds.length > 0 &&
        repositoryKey !== undefined &&
        requestedCommitOid !== undefined
          ? await code.getArtifacts(actor, {
              repositoryKey,
              commitOid: requestedCommitOid,
              artifactIds: anchoredArtifactIds,
            })
          : [];
      const selectedCodeArtifacts = [
        ...anchoredArtifacts,
        ...codeResults.filter(
          (artifact) =>
            !anchoredArtifacts.some((anchoredArtifact) => anchoredArtifact.id === artifact.id),
        ),
      ].slice(0, codeLimit);

      const anchoredMemoryIds = new Set(anchors.map((anchor) => anchor.memoryId));
      const memoryContext = memoryResults
        .map((result, ordinal) => ({ result, ordinal }))
        .sort((left, right) => {
          const anchored =
            Number(anchoredMemoryIds.has(right.result.memory.id)) -
            Number(anchoredMemoryIds.has(left.result.memory.id));
          return anchored || left.ordinal - right.ordinal;
        })
        .map(({ result }) => ({
          id: result.memory.id,
          scope: result.memory.scope,
          updatedAt: result.memory.updatedAt,
          score: result.score,
          ...(result.rerankScore === undefined ? {} : { rerankScore: result.rerankScore }),
          evidence: result.evidence,
        }));
      const codeContext = selectedCodeArtifacts.map((artifact) => ({
        artifactId: artifact.id,
        commitOid: artifact.commitOid,
        path: artifact.path,
        symbol: artifact.symbol,
        startLine: artifact.startLine,
        endLine: artifact.endLine,
        score: artifact.score,
        matchedChannels: [...artifact.matchedChannels],
        content: artifact.content,
      }));
      const conflicts = anchors.flatMap((anchor) => {
        const values: string[] = [];
        if (anchor.relationship === "contradicts") {
          values.push(`anchor:${anchor.id}:contradicts`);
        }
        if (anchor.localState !== "current" && anchor.localState !== "moved") {
          values.push(`anchor:${anchor.id}:${anchor.localState}`);
        }
        return values;
      });
      let contextualImpact: ContextualImpactAssessment | null = null;
      if (
        plan.needsContextualImpact &&
        repositoryKey !== undefined &&
        requestedCommitOid !== undefined
      ) {
        const selectedSubjects = contextualSubjects.slice(0, CONTEXTUAL_ANCHOR_LIMIT);
        const assessments = [];
        for (const selected of selectedSubjects) {
          const before = await dependencyFingerprints({
            actor,
            code,
            dependencies,
            repositoryKey,
            commitOid: selected.baseCommitOid,
            subject: selected.beforeSubject,
          });
          const after = await dependencyFingerprints({
            actor,
            code,
            dependencies,
            repositoryKey,
            commitOid: requestedCommitOid,
            subject: selected.afterSubject,
          });
          assessments.push({
            anchorId: selected.anchorId,
            assessment: assessContextualImpact(before.fingerprints, after.fingerprints, {
              beforeTruncated: before.truncated,
              afterTruncated: after.truncated,
            }),
          });
        }
        contextualImpact = aggregateContextualImpact(
          assessments,
          contextualSubjects.length > selectedSubjects.length,
        );
      }
      if (contextualImpact && contextualImpact.state !== "unaffected") {
        conflicts.push(`contextual-impact:${contextualImpact.state}`);
      }

      return {
        revision: CONTEXT_RETRIEVAL_REVISION,
        query,
        plan,
        deliveredRoute: deliveredRoute(memoryContext.length, codeContext.length, plan.route),
        memories: memoryContext,
        code: codeContext,
        anchors,
        conflicts,
        receipt: {
          memoryCandidates: memoryContext.length,
          codeCandidates: codeContext.length,
          anchorCandidates: anchors.length,
          requestedCommitOid: requestedCommitOid ?? null,
          memoryQuery,
          codeQuery,
          contextualImpact,
        },
      };
    },
  };
}
