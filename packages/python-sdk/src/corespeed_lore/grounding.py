"""Pure host-side retrieval grounding gate.

Hand-maintained port of ``src/lib/retrieval-grounding.ts``; keep the revision
string, patterns, and decision order behaviorally aligned with the TypeScript
module. ``re.ASCII`` keeps ``\\b``/``\\w`` on JavaScript's ASCII word-boundary
semantics so both implementations classify the same queries identically.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final, Literal

RETRIEVAL_GROUNDING_POLICY_REVISION: Final[str] = "retrieval-grounding-v5"

RetrievalGroundingMode = Literal["auto", "off", "required"]
RepositoryGroundingContext = Literal["configured", "exact", "none"]

#: Stable machine-readable reason for one grounding decision. Hosts switch on
#: this to render their own user-facing copy in the user's language instead of
#: matching the English ``reasons`` strings, which are for logs and receipts.
RetrievalGroundingReasonCode = Literal[
    "empty_query",
    "supplied_content_sufficient",
    "general_brainstorming",
    "missing_commit_oid",
    "repository_unconfigured",
    "stale_recollection",
    "exact_revision_code_truth",
    "workspace_history",
    "retrieval_optional",
]

_FLAGS = re.IGNORECASE | re.ASCII
#: JavaScript's ``\s`` set, spelled out because ``re.ASCII`` narrows Python's.
#: Without this the multi-word alternations below would silently fail on
#: U+00A0 / U+3000 and a Python host would skip grounding the TypeScript
#: source still requires — divergence in the unsafe direction.
_WS = "[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"

_MEMORY_PATTERN = re.compile(
    r"\b(remember(?:ed|ing)?|recollect(?:ion|ed|ing)?|preference|prefer(?:red|s|ring)?"
    r"|agree(?:d|s|ing|ment)?|meeting|personal|prior|previous(?:ly)?|earlier)\b"
    r"|之前|以前|曾经|约定|商量|讨论过|决定|决策|共识|偏好|怎么定",
    _FLAGS,
)
_STALE_CONFIRMATION_PATTERN = re.compile(r"\b(recollection|remember)\b", _FLAGS)
_SUPPLIED_TRANSFORMATION_PATTERN = re.compile(
    r"\b(rewrite|translate|summarize|shorten|proofread|format)\b"
    r"[^.!?]{0,80}\b(this|following|supplied|provided)\b",
    _FLAGS,
)
_GENERAL_BRAINSTORM_PATTERN = re.compile(
    r"\b(brainstorm|ideate|generate" + _WS + r"+ideas?)\b|头脑风暴|起.{0,12}名字|想.{0,12}名字",
    _FLAGS,
)
_REPOSITORY_TRUTH_PATTERN = re.compile(
    r"\b(exact" + _WS + r"+revision|revision|commit|current" + _WS + r"+(?:code|implementation)"
    r"|implemented|symbol|path|callers?|callees?|dependency|dependencies|guards?"
    r"|guarded" + _WS + r"+by)\b"
    r"|代码|实现|提交|函数|符号|路径|调用方|被谁调用|依赖|当前实现",
    _FLAGS,
)
_TEAM_FRAMING_PATTERN = re.compile(r"\b(our|ours|we|us)\b|我们|咱们|团队", _FLAGS)
_CURRENT_STATE_PATTERN = re.compile(r"\b(now|currently|today|still)\b", _FLAGS)
_CODE_BEHAVIOR_PATTERN = re.compile(
    r"\b(write|writes|writing|written|read|reads|insert|inserts|enforce|enforces"
    r"|guard|guards|allow|allows|reject|rejects|return|returns|call|calls)\b",
    _FLAGS,
)

_MISSING_REVISION_CLARIFICATION: Final[str] = (
    "Verifying current Code requires the exact full commit OID (40- or 64-character "
    "Git object id) for the configured repository. Please provide that exact revision; "
    "Memory search is not a substitute for current Code truth."
)
_UNCONFIGURED_REPOSITORY_CLARIFICATION: Final[str] = (
    "This deployment has no code repository registered, so current Code cannot be "
    "verified. An operator must configure the repository in LORE_CODE_REPOSITORIES "
    "before exact-revision Code retrieval is possible; Memory search is not a "
    "substitute for current Code truth."
)


@dataclass(frozen=True, slots=True)
class RetrievalGroundingPlan:
    """Versioned host decision for one original user question."""

    mode: RetrievalGroundingMode
    should_retrieve: bool
    should_clarify: bool
    reason_code: RetrievalGroundingReasonCode
    clarification: str | None
    reasons: tuple[str, ...]


def _code_grounding_clarification(context: RepositoryGroundingContext) -> str:
    if context == "none":
        return _UNCONFIGURED_REPOSITORY_CLARIFICATION
    return _MISSING_REVISION_CLARIFICATION


def _code_grounding_reason_code(
    context: RepositoryGroundingContext,
) -> RetrievalGroundingReasonCode:
    if context == "none":
        return "repository_unconfigured"
    return "missing_commit_oid"


def plan_retrieval_grounding(
    query: str,
    repository_context: RepositoryGroundingContext,
) -> RetrievalGroundingPlan:
    """Choose required/auto/off grounding for one original user question."""

    trimmed = query.strip()
    if not trimmed:
        return RetrievalGroundingPlan(
            mode="off",
            should_retrieve=False,
            should_clarify=False,
            clarification=None,
            reason_code="empty_query",
        reasons=("empty query",),
        )

    if _SUPPLIED_TRANSFORMATION_PATTERN.search(trimmed):
        return RetrievalGroundingPlan(
            mode="off",
            should_retrieve=False,
            should_clarify=False,
            clarification=None,
            reason_code="supplied_content_sufficient",
        reasons=("supplied content is sufficient for the requested transformation",),
        )

    if (
        _GENERAL_BRAINSTORM_PATTERN.search(trimmed)
        and not _MEMORY_PATTERN.search(trimmed)
        and not _REPOSITORY_TRUTH_PATTERN.search(trimmed)
    ):
        return RetrievalGroundingPlan(
            mode="off",
            should_retrieve=False,
            should_clarify=False,
            clarification=None,
            reason_code="general_brainstorming",
        reasons=("general brainstorming does not require stored evidence",),
        )

    has_exact_revision = repository_context == "exact"
    stale_current_code_claim = bool(
        _STALE_CONFIRMATION_PATTERN.search(trimmed)
        and _CURRENT_STATE_PATTERN.search(trimmed)
        and _CODE_BEHAVIOR_PATTERN.search(trimmed)
    )
    if stale_current_code_claim and not has_exact_revision:
        return RetrievalGroundingPlan(
            mode="off",
            should_retrieve=False,
            should_clarify=True,
            clarification=_code_grounding_clarification(repository_context),
            reason_code=_code_grounding_reason_code(repository_context),
            reasons=("current Code verification requires repository and exact commit context",),
        )

    if _STALE_CONFIRMATION_PATTERN.search(trimmed):
        return RetrievalGroundingPlan(
            mode="required",
            should_retrieve=True,
            should_clarify=False,
            clarification=None,
            reason_code="stale_recollection",
        reasons=("possibly stale recollection requires authorized evidence",),
        )

    # Deliberative-recall wording keeps Memory retrieval available even when the
    # question also uses generic code vocabulary; clarification would strand a
    # question that Memory evidence alone can answer.
    deliberative = bool(
        _MEMORY_PATTERN.search(trimmed) or _TEAM_FRAMING_PATTERN.search(trimmed)
    )
    if _REPOSITORY_TRUTH_PATTERN.search(trimmed) and not has_exact_revision and not deliberative:
        return RetrievalGroundingPlan(
            mode="off",
            should_retrieve=False,
            should_clarify=True,
            clarification=_code_grounding_clarification(repository_context),
            reason_code=_code_grounding_reason_code(repository_context),
            reasons=("exact-revision Code grounding requires repository and commit context",),
        )

    if _REPOSITORY_TRUTH_PATTERN.search(trimmed) and has_exact_revision:
        return RetrievalGroundingPlan(
            mode="required",
            should_retrieve=True,
            should_clarify=False,
            clarification=None,
            reason_code="exact_revision_code_truth",
        reasons=("exact-revision Code truth requires authorized Code evidence",),
        )

    if deliberative:
        return RetrievalGroundingPlan(
            mode="required",
            should_retrieve=True,
            should_clarify=False,
            clarification=None,
            reason_code="workspace_history",
        reasons=("Workspace or user-specific history requires authorized Memory evidence",),
        )

    return RetrievalGroundingPlan(
        mode="auto",
        should_retrieve=False,
        should_clarify=False,
        clarification=None,
        reason_code="retrieval_optional",
        reasons=("retrieval may help but is not required",),
    )
