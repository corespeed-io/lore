// Generated from src/lib/retrieval-grounding.ts. Do not edit by hand.
/**
 * Pure host-side retrieval grounding gate.
 *
 * This module is self-contained by design: `tools/sdk-codegen` copies it
 * verbatim into the TypeScript SDK so model hosts apply the same versioned
 * required/auto/off policy Lore's benchmarks pin. Keep it free of imports.
 */

export const RETRIEVAL_GROUNDING_POLICY_REVISION = "retrieval-grounding-v4";

export type RetrievalGroundingMode = "auto" | "off" | "required";

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

export const MEMORY_PATTERN =
  /\b(remember(?:ed|ing)?|recollect(?:ion|ed|ing)?|preference|prefer(?:red|s|ring)?|agree(?:d|s|ing|ment)?|meeting|personal|prior|previous(?:ly)?|earlier)\b|之前|以前|曾经|约定|商量|讨论过|决定|决策|共识|偏好|怎么定/i;
export const STALE_CONFIRMATION_PATTERN = /\b(recollection|remember)\b/i;
export const SUPPLIED_TRANSFORMATION_PATTERN =
  /\b(rewrite|translate|summarize|shorten|proofread|format)\b[^.!?]{0,80}\b(this|following|supplied|provided)\b/i;
export const GENERAL_BRAINSTORM_PATTERN =
  /\b(brainstorm|ideate|generate\s+ideas?)\b|头脑风暴|起.{0,12}名字|想.{0,12}名字/i;
export const REPOSITORY_TRUTH_PATTERN =
  /\b(exact\s+revision|revision|commit|current\s+(?:code|implementation)|implemented|symbol|path|callers?|callees?|dependency|dependencies|guards?|guarded\s+by)\b|代码|实现|提交|函数|符号|路径|调用方|被谁调用|依赖|当前实现/i;
/**
 * First-person-plural framing marks a question about the team's own knowledge.
 * Code vocabulary inside such a question ("our commit message convention") is
 * usually incidental, so Memory answers it instead of a canned clarification.
 */
export const TEAM_FRAMING_PATTERN = /\b(our|ours|we|us)\b|我们|咱们|团队/i;
export const CURRENT_STATE_PATTERN = /\b(now|currently|today|still)\b/i;
export const CODE_BEHAVIOR_PATTERN =
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

  // Deliberative-recall wording and team framing keep Memory retrieval
  // available even when the question also uses generic code vocabulary;
  // clarification would strand a question Memory evidence alone can answer.
  const deliberative = MEMORY_PATTERN.test(query) || TEAM_FRAMING_PATTERN.test(query);
  if (REPOSITORY_TRUTH_PATTERN.test(query) && !hasExactRevision && !deliberative) {
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

  if (deliberative) {
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
