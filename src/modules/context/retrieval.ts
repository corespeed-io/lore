import type { MemoryModuleOptions, MemoryScope, PostgresDatabase } from "@corespeed/lore-core";
import type {
  CodeEvidenceRelationship,
  CodeEvidenceValidationState,
  MemoryCodeEvidence,
} from "@/modules/code/evidence";
import { createCodeEvidenceModule } from "@/modules/code/evidence";
import { createCodeDependencyGraphModule } from "@/modules/code/graph";
import { createCodeIndexReadModule } from "@/modules/code/indexing/read";
import {
  validateCommitOid,
  validateQueryText,
  validateRepositoryKey,
} from "@/modules/code/indexing/validation";
import { createMemoryModule } from "@/modules/memories/service";
import type { ActorContext } from "@/server/auth/actor-context";
import type {
  ContextualImpactAssessment,
  DependencyFingerprint,
  JointEvidenceIntent,
  JointEvidenceRoute,
} from "./policy";
import {
  aggregateContextualImpact,
  assessContextualImpact,
  CONTEXTUAL_ANCHOR_LIMIT,
  CONTEXTUAL_EDGE_LIMIT,
  MAXIMUM_CONTEXT_ANCHORS,
  planJointEvidenceRoute,
} from "./policy";

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

type DependencySubject = { path: string } | { symbol: string };

/**
 * The cited declaration at `path`. A symbol key is its path, `#`, and a path-free suffix;
 * a repository path may itself contain `#`, so the suffix follows the known cited-path
 * prefix rather than the first `#`.
 */
function dependencySubject(citation: MemoryCodeEvidence, path: string): DependencySubject {
  const symbolKey = citation.citedSymbolKey;
  if (!symbolKey) return { path };
  const citedPrefix = `${citation.citedPath}#`;
  if (!symbolKey.startsWith(citedPrefix)) return { symbol: symbolKey };
  return { symbol: `${path}#${symbolKey.slice(citedPrefix.length)}` };
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

function queryText(value: string, name: string, maximumLength: number): string {
  return validateQueryText(value, name, maximumLength, ContextRetrievalValidationError);
}

function limit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new ContextRetrievalValidationError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return normalized;
}

function deliveredRoute(memoryCount: number, codeCount: number) {
  if (memoryCount > 0 && codeCount > 0) return "both" as const;
  if (memoryCount > 0) return "memory-only" as const;
  if (codeCount > 0) return "code-only" as const;
  // No evidence in either family: abstain regardless of what was planned.
  return "abstain" as const;
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
      const query = queryText(input.query, "query", 10_000);
      const repositoryKey =
        input.repositoryKey === undefined
          ? undefined
          : validateRepositoryKey(input.repositoryKey, ContextRetrievalValidationError);
      const requestedCommitOid =
        input.commitOid === undefined
          ? undefined
          : validateCommitOid(input.commitOid, ContextRetrievalValidationError);
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
          ? queryText(input.memoryQuery ?? query, "memoryQuery", 10_000)
          : null;
      const codeQuery =
        plan.route === "code-only" || plan.route === "both"
          ? queryText(input.codeQuery ?? query, "codeQuery", 2_000)
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
      // More citations existed than one packet carries, so some were never assessed.
      let anchorsTruncated = false;
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
        requestedCommitOid !== undefined &&
        memoryResults.length > 0
      ) {
        // One read-only transaction lists and assesses the citations of every result Memory,
        // in result order. Retrieval never persists revalidation. One citation past the cap
        // proves that the packet is incomplete; it is dropped, never delivered.
        const assessed = await evidence.assessMemoryCitations(actor, {
          memoryIds: memoryResults.map((result) => result.memory.id),
          repositoryKey,
          commitOid: requestedCommitOid,
          limit: MAXIMUM_CONTEXT_ANCHORS + 1,
        });
        anchorsTruncated = assessed.length > MAXIMUM_CONTEXT_ANCHORS;
        for (const { citation, assessment } of assessed.slice(0, MAXIMUM_CONTEXT_ANCHORS)) {
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
        // With no cited declaration to compare, there is nothing to assess:
        // reporting `unknown` here would brand every dependency question with
        // a permanent conflict that describes the absence of anchors, not the
        // code. Truncated or unresolved traversal still reports `unknown`, and so
        // does a citation list cut at the packet cap, whose unassessed rest may
        // hold a declaration.
        (contextualSubjects.length > 0 || anchorsTruncated) &&
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
          anchorsTruncated || contextualSubjects.length > selectedSubjects.length,
        );
      }
      if (contextualImpact && contextualImpact.state !== "unaffected") {
        conflicts.push(`contextual-impact:${contextualImpact.state}`);
      }

      return {
        revision: CONTEXT_RETRIEVAL_REVISION,
        query,
        plan,
        deliveredRoute: deliveredRoute(memoryContext.length, codeContext.length),
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
