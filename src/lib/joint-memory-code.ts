/**
 * Pure joint Memory + Code routing and evidence-packet policy.
 *
 * Storage, authorization, and retrieval remain in their independent domain
 * modules. This file only plans a route and assembles typed evidence.
 */

import type { CodeEvidenceRelationship, CodeEvidenceValidationState } from "./code-evidence";

export const JOINT_MEMORY_CODE_PROTOTYPE_REVISION = "joint-memory-code-prototype-v2";
export const RETRIEVAL_GROUNDING_POLICY_REVISION = "retrieval-grounding-v3";

export type JointEvidenceRoute = "abstain" | "both" | "code-only" | "memory-only";
export type RetrievalGroundingMode = "auto" | "off" | "required";

export type JointEvidenceIntent =
  | "blast-radius"
  | "change"
  | "current-code"
  | "memory-recall"
  | "rationale"
  | "unknown";

export type ContextualImpactState = "affected" | "possibly_affected" | "unaffected" | "unknown";

export interface JointEvidenceQuery {
  query: string;
  hasRepositoryContext: boolean;
  route?: JointEvidenceRoute | "auto";
}

/**
 * Trusted host state about Code grounding availability:
 * `exact` = repository key plus full commit OID selected;
 * `configured` = a repository is registered but no exact commit is selected;
 * `none` = the deployment has no code repository registered at all.
 */
export type RepositoryGroundingContext = "configured" | "exact" | "none";

export interface RetrievalGroundingQuery {
  query: string;
  repositoryContext: RepositoryGroundingContext;
}

export interface RetrievalGroundingPlan {
  mode: RetrievalGroundingMode;
  shouldRetrieve: boolean;
  shouldClarify: boolean;
  /**
   * User-facing clarification a host returns verbatim, without a model turn,
   * whenever `shouldClarify` is true. Null otherwise.
   */
  clarification: string | null;
  reasons: string[];
}

export interface JointRoutePlan {
  intent: JointEvidenceIntent;
  route: JointEvidenceRoute;
  needsAnchorExpansion: boolean;
  needsContextualImpact: boolean;
  needsLocalAssessment: boolean;
  reasons: string[];
}

export interface JointMemoryEvidence {
  id: string;
  content: string;
  score: number;
}

export interface JointCodeEvidence {
  artifactId: string;
  commitOid: string;
  content: string;
  contentSha256: string;
  matchText?: string | null;
  path: string;
  score: number;
  symbol: string | null;
}

export interface JointAnchorEvidence {
  id: string;
  memoryId: string;
  relationship: CodeEvidenceRelationship;
  localState: CodeEvidenceValidationState;
  citedCommitOid: string;
  citedPath: string;
  citedDeclarationChunkOrdinal: number | null;
  citedDeclarationContextSha256: string | null;
  validatedCommitOid: string | null;
  validatedPath: string | null;
}

export interface DependencyFingerprint {
  kind: string;
  resolution: "ambiguous" | "resolved" | "unresolved";
  targetKey: string;
  contentSha256: string | null;
}

export interface ContextualImpactAssessment {
  state: ContextualImpactState;
  changes: string[];
}

export interface JointEvidenceReceipt {
  memoryCandidates: number;
  codeCandidates: number;
  anchorCandidates: number;
  requestedCommitOid: string | null;
  contextualImpact: ContextualImpactAssessment | null;
}

export interface GroupedJointEvidencePacket {
  revision: string;
  query: string;
  plan: JointRoutePlan;
  deliveredRoute: JointEvidenceRoute;
  memories: JointMemoryEvidence[];
  code: JointCodeEvidence[];
  anchors: JointAnchorEvidence[];
  conflicts: string[];
  receipt: JointEvidenceReceipt;
}

const RATIONALE_PATTERN = /\b(why|rationale|reason|designed|decision|constraint)\b/i;
const CHANGE_PATTERN = /\b(change|changed|drift|stale|still|contradict|historical|history)\b/i;
const BLAST_RADIUS_PATTERN =
  /\b(impact|blast\s+radius|callers?|callees?|depend(?:s|ed|ing|ent|ency|encies)?|tests?)\b/i;
const MEMORY_PATTERN =
  /\b(remember(?:ed|ing)?|recollect(?:ion|ed|ing)?|preference|prefer(?:red|s|ring)?|agree(?:d|s|ing|ment)?|meeting|personal|prior|previous(?:ly)?|earlier)\b|之前|以前|曾经|约定|商量|讨论过|决定|决策|共识|偏好|怎么定/i;
const CODE_PATTERN =
  /\b(code|current\s+implementation|implemented|works?\s+now|symbol|path|literal|function|class|find|where|guards?)\b|代码|实现|提交|函数|类|符号|路径|哪里|哪儿|什么地方|调用方|被谁调用|依赖|当前|现在/i;
const STALE_CONFIRMATION_PATTERN = /\b(recollection|remember)\b/i;
const SUPPLIED_TRANSFORMATION_PATTERN =
  /\b(rewrite|translate|summarize|shorten|proofread|format)\b[^.!?]{0,80}\b(this|following|supplied|provided)\b/i;
const GENERAL_BRAINSTORM_PATTERN =
  /\b(brainstorm|ideate|generate\s+ideas?)\b|头脑风暴|起.{0,12}名字|想.{0,12}名字/i;
const REPOSITORY_TRUTH_PATTERN =
  /\b(exact\s+revision|revision|commit|current\s+(?:code|implementation)|implemented|symbol|path|callers?|callees?|dependency|dependencies|guards?|guarded\s+by)\b|代码|实现|提交|函数|符号|路径|调用方|被谁调用|依赖|当前实现/i;
const CURRENT_STATE_PATTERN = /\b(now|currently|today|still)\b/i;
const CODE_BEHAVIOR_PATTERN =
  /\b(write|writes|writing|written|read|reads|insert|inserts|enforce|enforces|guard|guards|allow|allows|reject|rejects|return|returns|call|calls)\b/i;

const MISSING_REVISION_CLARIFICATION =
  "Verifying current Code requires the exact full commit OID (40- or 64-character Git object id) for the configured repository. Please provide that exact revision; Memory search is not a substitute for current Code truth.";
const UNCONFIGURED_REPOSITORY_CLARIFICATION =
  "This deployment has no code repository registered, so current Code cannot be verified. An operator must configure the repository in LORE_CODE_REPOSITORIES before exact-revision Code retrieval is possible; Memory search is not a substitute for current Code truth.";

function codeGroundingClarification(context: RepositoryGroundingContext): string {
  return context === "none"
    ? UNCONFIGURED_REPOSITORY_CLARIFICATION
    : MISSING_REVISION_CLARIFICATION;
}

export function planRetrievalGrounding(input: RetrievalGroundingQuery): RetrievalGroundingPlan {
  const query = input.query.trim();
  if (!query) {
    return {
      mode: "off",
      shouldRetrieve: false,
      shouldClarify: false,
      clarification: null,
      reasons: ["empty query"],
    };
  }

  if (SUPPLIED_TRANSFORMATION_PATTERN.test(query)) {
    return {
      mode: "off",
      shouldRetrieve: false,
      shouldClarify: false,
      clarification: null,
      reasons: ["supplied content is sufficient for the requested transformation"],
    };
  }

  if (
    GENERAL_BRAINSTORM_PATTERN.test(query) &&
    !MEMORY_PATTERN.test(query) &&
    !REPOSITORY_TRUTH_PATTERN.test(query)
  ) {
    return {
      mode: "off",
      shouldRetrieve: false,
      shouldClarify: false,
      clarification: null,
      reasons: ["general brainstorming does not require stored evidence"],
    };
  }

  const hasExactRevision = input.repositoryContext === "exact";
  const staleCurrentCodeClaim =
    STALE_CONFIRMATION_PATTERN.test(query) &&
    CURRENT_STATE_PATTERN.test(query) &&
    CODE_BEHAVIOR_PATTERN.test(query);
  if (staleCurrentCodeClaim && !hasExactRevision) {
    return {
      mode: "off",
      shouldRetrieve: false,
      shouldClarify: true,
      clarification: codeGroundingClarification(input.repositoryContext),
      reasons: ["current Code verification requires repository and exact commit context"],
    };
  }

  if (STALE_CONFIRMATION_PATTERN.test(query)) {
    return {
      mode: "required",
      shouldRetrieve: true,
      shouldClarify: false,
      clarification: null,
      reasons: ["possibly stale recollection requires authorized evidence"],
    };
  }

  // Deliberative-recall wording keeps Memory retrieval available even when the
  // question also uses generic code vocabulary; clarification would strand a
  // question that Memory evidence alone can answer.
  if (REPOSITORY_TRUTH_PATTERN.test(query) && !hasExactRevision && !MEMORY_PATTERN.test(query)) {
    return {
      mode: "off",
      shouldRetrieve: false,
      shouldClarify: true,
      clarification: codeGroundingClarification(input.repositoryContext),
      reasons: ["exact-revision Code grounding requires repository and commit context"],
    };
  }

  if (REPOSITORY_TRUTH_PATTERN.test(query) && hasExactRevision) {
    return {
      mode: "required",
      shouldRetrieve: true,
      shouldClarify: false,
      clarification: null,
      reasons: ["exact-revision Code truth requires authorized Code evidence"],
    };
  }

  if (MEMORY_PATTERN.test(query)) {
    return {
      mode: "required",
      shouldRetrieve: true,
      shouldClarify: false,
      clarification: null,
      reasons: ["Workspace or user-specific history requires authorized Memory evidence"],
    };
  }

  return {
    mode: "auto",
    shouldRetrieve: false,
    shouldClarify: false,
    clarification: null,
    reasons: ["retrieval may help but is not required"],
  };
}

export function planJointEvidenceRoute(input: JointEvidenceQuery): JointRoutePlan {
  const query = input.query.trim();
  if (!query) {
    return {
      intent: "unknown",
      route: "abstain",
      needsAnchorExpansion: false,
      needsContextualImpact: false,
      needsLocalAssessment: false,
      reasons: ["empty query"],
    };
  }

  if (input.route && input.route !== "auto") {
    return {
      intent: "unknown",
      route: input.route,
      needsAnchorExpansion: input.route === "both",
      needsContextualImpact: false,
      needsLocalAssessment: input.route === "both" && input.hasRepositoryContext,
      reasons: ["explicit route override"],
    };
  }

  if (
    CHANGE_PATTERN.test(query) ||
    (STALE_CONFIRMATION_PATTERN.test(query) &&
      CURRENT_STATE_PATTERN.test(query) &&
      CODE_BEHAVIOR_PATTERN.test(query))
  ) {
    return {
      intent: "change",
      route: input.hasRepositoryContext ? "both" : "memory-only",
      needsAnchorExpansion: input.hasRepositoryContext,
      needsContextualImpact: input.hasRepositoryContext,
      needsLocalAssessment: input.hasRepositoryContext,
      reasons: ["change questions require historical claims and current evidence"],
    };
  }

  if (RATIONALE_PATTERN.test(query)) {
    return {
      intent: "rationale",
      route: input.hasRepositoryContext ? "both" : "memory-only",
      needsAnchorExpansion: input.hasRepositoryContext,
      needsContextualImpact: false,
      needsLocalAssessment: input.hasRepositoryContext,
      reasons: ["rationale starts from reviewed Memory and verifies current code"],
    };
  }

  if (BLAST_RADIUS_PATTERN.test(query) && input.hasRepositoryContext) {
    return {
      intent: "blast-radius",
      route: "code-only",
      needsAnchorExpansion: false,
      needsContextualImpact: true,
      needsLocalAssessment: false,
      reasons: ["blast radius is an exact-revision structural code question"],
    };
  }

  if (MEMORY_PATTERN.test(query)) {
    return {
      intent: "memory-recall",
      route: "memory-only",
      needsAnchorExpansion: false,
      needsContextualImpact: false,
      needsLocalAssessment: false,
      reasons: ["personal or deliberative recall has no default Code tax"],
    };
  }

  if (CODE_PATTERN.test(query) && input.hasRepositoryContext) {
    return {
      intent: "current-code",
      route: "code-only",
      needsAnchorExpansion: false,
      needsContextualImpact: false,
      needsLocalAssessment: false,
      reasons: ["current implementation and locator questions prefer exact-revision Code"],
    };
  }

  return {
    intent: "unknown",
    route: "abstain",
    needsAnchorExpansion: false,
    needsContextualImpact: false,
    needsLocalAssessment: false,
    reasons: ["no route has enough evidence of benefit"],
  };
}

function fingerprintKey(fingerprint: DependencyFingerprint): string {
  return `${fingerprint.kind}\0${fingerprint.targetKey}`;
}

export function assessContextualImpact(
  before: readonly DependencyFingerprint[],
  after: readonly DependencyFingerprint[],
  options: { beforeTruncated?: boolean; afterTruncated?: boolean } = {},
): ContextualImpactAssessment {
  const previous = new Map(before.map((fingerprint) => [fingerprintKey(fingerprint), fingerprint]));
  const current = new Map(after.map((fingerprint) => [fingerprintKey(fingerprint), fingerprint]));
  const changes: string[] = [];
  let knownContentChange = false;
  let structuralChange = false;
  let uncertainty = Boolean(options.beforeTruncated || options.afterTruncated);
  if (options.beforeTruncated) changes.push("truncated:before");
  if (options.afterTruncated) changes.push("truncated:after");

  for (const key of new Set([...previous.keys(), ...current.keys()])) {
    const left = previous.get(key);
    const right = current.get(key);
    if (!left || !right) {
      structuralChange = true;
      changes.push(`${left ? "removed" : "added"}:${key.replace("\0", ":")}`);
      continue;
    }
    if (left.resolution !== "resolved" || right.resolution !== "resolved") {
      uncertainty = true;
      if (left.resolution === right.resolution) {
        changes.push(`uncertain:${key.replace("\0", ":")}`);
      }
    }
    if (left.resolution !== right.resolution) {
      structuralChange = true;
      changes.push(`resolution:${key.replace("\0", ":")}`);
      continue;
    }
    if (left.contentSha256 && right.contentSha256) {
      if (left.contentSha256 !== right.contentSha256) {
        knownContentChange = true;
        changes.push(`content:${key.replace("\0", ":")}`);
      }
    } else if (left.resolution === "resolved" || right.resolution === "resolved") {
      uncertainty = true;
      changes.push(`content-unavailable:${key.replace("\0", ":")}`);
    }
  }

  if (knownContentChange) return { state: "affected", changes };
  if (structuralChange) return { state: "possibly_affected", changes };
  if (uncertainty) return { state: "unknown", changes };
  return { state: "unaffected", changes };
}

function deliveredRoute(
  planned: JointEvidenceRoute,
  memoryCount: number,
  codeCount: number,
): JointEvidenceRoute {
  if (memoryCount > 0 && codeCount > 0) return "both";
  if (memoryCount > 0) return "memory-only";
  if (codeCount > 0) return "code-only";
  return planned === "abstain" ? planned : "abstain";
}

export function assembleGroupedJointEvidence(input: {
  query: string;
  plan: JointRoutePlan;
  memories?: readonly JointMemoryEvidence[];
  code?: readonly JointCodeEvidence[];
  anchors?: readonly JointAnchorEvidence[];
  requestedCommitOid?: string | null;
  contextualImpact?: ContextualImpactAssessment | null;
}): GroupedJointEvidencePacket {
  const memories = [...(input.memories ?? [])];
  const code = [...(input.code ?? [])];
  const anchors = [...(input.anchors ?? [])];
  const contextualImpact = input.contextualImpact ?? null;
  const conflicts = anchors.flatMap((anchor) => {
    const found: string[] = [];
    if (anchor.relationship === "contradicts") found.push(`anchor:${anchor.id}:contradicts`);
    if (!["current", "moved"].includes(anchor.localState)) {
      found.push(`anchor:${anchor.id}:${anchor.localState}`);
    }
    return found;
  });
  if (contextualImpact && contextualImpact.state !== "unaffected") {
    conflicts.push(`contextual-impact:${contextualImpact.state}`);
  }

  return {
    revision: JOINT_MEMORY_CODE_PROTOTYPE_REVISION,
    query: input.query,
    plan: input.plan,
    deliveredRoute: deliveredRoute(input.plan.route, memories.length, code.length),
    memories,
    code,
    anchors,
    conflicts,
    receipt: {
      memoryCandidates: memories.length,
      codeCandidates: code.length,
      anchorCandidates: anchors.length,
      requestedCommitOid: input.requestedCommitOid ?? null,
      contextualImpact,
    },
  };
}

export function prioritizeAnchoredMemories(
  memories: readonly JointMemoryEvidence[],
  anchors: readonly JointAnchorEvidence[],
): JointMemoryEvidence[] {
  const anchoredMemoryIds = new Set(anchors.map((anchor) => anchor.memoryId));
  return memories
    .map((memory, ordinal) => ({ memory, ordinal }))
    .sort((left, right) => {
      const anchoredDifference =
        Number(anchoredMemoryIds.has(right.memory.id)) -
        Number(anchoredMemoryIds.has(left.memory.id));
      return anchoredDifference || left.ordinal - right.ordinal;
    })
    .map(({ memory }) => memory);
}
