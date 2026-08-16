import type {
  CodeEvidenceRelationship,
  CodeEvidenceValidationState,
  MemoryCodeEvidence,
} from "./types";

/**
 * Presentation model for Memory-to-Code citation anchors.
 *
 * The Code Evidence module assesses six validation states. Three of them —
 * `changed`, `deleted`, and `ambiguous` — mean the Memory's claim may no longer
 * describe the code it cites, so a reader must not miss them. This module owns
 * that ranking as pure data; the component only assigns class membership.
 *
 * Nothing here derives a filesystem location. `repositoryPath` is operator-only
 * server state and is absent from the browser contract by construction.
 */
export type CodeEvidenceTone = "alert" | "notice" | "ok" | "unknown";

interface CodeEvidenceStatePresentation {
  tone: CodeEvidenceTone;
  label: string;
  description: string;
}

const STATE_PRESENTATION: Record<CodeEvidenceValidationState, CodeEvidenceStatePresentation> = {
  current: {
    tone: "ok",
    label: "current",
    description: "The cited code still matches this citation.",
  },
  moved: {
    tone: "notice",
    label: "moved",
    description: "The cited code is unchanged but now lives at a different path.",
  },
  changed: {
    tone: "alert",
    label: "changed",
    description: "The cited code changed after this Memory cited it.",
  },
  deleted: {
    tone: "alert",
    label: "deleted",
    description: "The cited code no longer exists at the validated revision.",
  },
  ambiguous: {
    tone: "alert",
    label: "ambiguous",
    description:
      "Lore could not identify one matching declaration, so this anchor is unresolved rather than fresh.",
  },
  unverifiable: {
    tone: "unknown",
    label: "unverifiable",
    description: "Lore has no indexed generation to validate this citation against.",
  },
};

const RELATIONSHIP_DESCRIPTION: Record<CodeEvidenceRelationship, string> = {
  supports: "This code supports the Memory.",
  contradicts: "This code contradicts the Memory.",
  implements: "This code implements the Memory.",
  rationale: "The Memory explains why this code is the way it is.",
};

const TONE_ORDER: Record<CodeEvidenceTone, number> = { alert: 0, unknown: 1, notice: 2, ok: 3 };

export interface CodeEvidenceRow {
  id: string;
  tone: CodeEvidenceTone;
  stateLabel: string;
  stateDescription: string;
  relationship: CodeEvidenceRelationship;
  relationshipDescription: string;
  /** Repository-relative path recorded when the Memory cited this code. */
  citedPath: string;
  /** Repository-relative path the last assessment resolved to, when it differs. */
  movedToPath: string | null;
  /** Most specific locator Lore froze: declaration, else symbol, else the file. */
  locator: string;
  declarationChunkOrdinal: number | null;
  citedCommitOid: string;
  validatedCommitOid: string | null;
  validatedAt: string;
}

export interface CodeEvidenceSummary {
  rows: CodeEvidenceRow[];
  total: number;
  attentionCount: number;
  /** Single sentence for the detail notice, or null when nothing needs attention. */
  attentionMessage: string | null;
}

export function shortCommitOid(commitOid: string): string {
  return commitOid.slice(0, 12);
}

/**
 * Whether the Memory detail shows a citation section at all.
 *
 * Most Memories never cite code, so "no citations" is `hidden`, not an empty
 * row — a permanent placeholder would be dead chrome in every ordinary
 * Memory's context column. A failed read is `error` rather than `hidden`,
 * because an unread list cannot be told apart from an empty one and quietly
 * hiding it could hide drift on a Memory that does cite code.
 */
export function codeEvidenceSectionState(input: {
  hasError: boolean;
  total: number;
}): "error" | "hidden" | "list" {
  if (input.hasError) return "error";
  return input.total === 0 ? "hidden" : "list";
}

function toRow(evidence: MemoryCodeEvidence): CodeEvidenceRow {
  const state = STATE_PRESENTATION[evidence.validationState];
  const movedToPath =
    evidence.validatedPath && evidence.validatedPath !== evidence.citedPath
      ? evidence.validatedPath
      : null;
  return {
    id: evidence.id,
    tone: state.tone,
    stateLabel: state.label,
    stateDescription: state.description,
    relationship: evidence.relationship,
    relationshipDescription: RELATIONSHIP_DESCRIPTION[evidence.relationship],
    citedPath: evidence.citedPath,
    movedToPath,
    locator: evidence.citedDeclarationKey ?? evidence.citedSymbolKey ?? evidence.citedPath,
    declarationChunkOrdinal: evidence.citedDeclarationChunkOrdinal,
    citedCommitOid: evidence.citedCommitOid,
    validatedCommitOid:
      evidence.validatedCommitOid && evidence.validatedCommitOid !== evidence.citedCommitOid
        ? evidence.validatedCommitOid
        : null,
    validatedAt: evidence.validatedAt,
  };
}

/**
 * Rank drift-bearing citations first so a stale claim is visible without
 * scrolling, then keep a deterministic path/id order inside each tone.
 */
export function summarizeCodeEvidence(
  evidence: readonly MemoryCodeEvidence[],
): CodeEvidenceSummary {
  const rows = evidence
    .map(toRow)
    .sort(
      (left, right) =>
        TONE_ORDER[left.tone] - TONE_ORDER[right.tone] ||
        left.citedPath.localeCompare(right.citedPath) ||
        left.id.localeCompare(right.id),
    );
  const attentionCount = rows.filter((row) => row.tone === "alert").length;
  return {
    rows,
    total: rows.length,
    attentionCount,
    attentionMessage: attentionCount
      ? `${attentionCount} of ${rows.length} code citation${rows.length === 1 ? "" : "s"} no longer match${attentionCount === 1 ? "es" : ""} the cited code.`
      : null,
  };
}
