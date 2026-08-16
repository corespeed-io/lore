/** PROTOTYPE — fixed reader contract for grouped Memory + Code evidence. */

import type { GroupedJointEvidencePacket } from "./joint-memory-code-prototype";

export const JOINT_READER_PROTOTYPE_REVISION = "joint-evidence-reader-v1";

export type JointReaderEvidenceKind = "anchor" | "code" | "memory";

export interface JointReaderEvidenceItem {
  id: string;
  kind: JointReaderEvidenceKind;
  text: string;
}

export interface JointReaderClaim {
  text: string;
  citations: string[];
}

export interface JointReaderOutput {
  answer: string;
  abstain: boolean;
  claims: JointReaderClaim[];
}

export interface JointReaderExpectation {
  abstain: boolean;
  forbiddenTerms?: readonly string[];
  requiredCitationKinds?: readonly JointReaderEvidenceKind[];
  requiredTerms?: readonly string[];
}

export interface JointReaderScore {
  abstentionCorrect: boolean;
  citationCompleteness: boolean;
  citationIdsValid: boolean;
  forbiddenTermsAbsent: boolean;
  requiredCitationKindsPresent: boolean;
  requiredTermsPresent: boolean;
}

function bounded(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function boundedAround(value: string, matchText: string | null | undefined, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const needle = matchText?.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const matchLength = needle?.length ?? 0;
  const matchIndex = needle ? normalized.toLocaleLowerCase().indexOf(needle) : -1;
  if (normalized.length <= limit || matchIndex < 0) return bounded(normalized, limit);
  const contextBefore = Math.floor((limit - matchLength) / 2);
  const start = Math.max(0, Math.min(matchIndex - contextBefore, normalized.length - limit));
  const end = Math.min(normalized.length, start + limit);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end).trim()}${
    end < normalized.length ? "…" : ""
  }`;
}

export function buildJointReaderPrompt(
  packet: GroupedJointEvidencePacket,
  options: { maximumEvidenceItems?: number } = {},
): { evidence: JointReaderEvidenceItem[]; prompt: string } {
  const maximumEvidenceItems = Math.max(1, Math.min(options.maximumEvidenceItems ?? 8, 12));
  const evidence: JointReaderEvidenceItem[] = [];
  for (const [index, memory] of packet.memories.entries()) {
    evidence.push({ id: `M${index + 1}`, kind: "memory", text: bounded(memory.content, 1_200) });
  }
  for (const [index, artifact] of packet.code.entries()) {
    evidence.push({
      id: `C${index + 1}`,
      kind: "code",
      text: bounded(
        `${artifact.path} @ ${artifact.commitOid}\n${boundedAround(
          artifact.content,
          artifact.matchText,
          1_600,
        )}`,
        1_800,
      ),
    });
  }
  for (const [index, anchor] of packet.anchors.entries()) {
    evidence.push({
      id: `A${index + 1}`,
      kind: "anchor",
      text: bounded(
        [
          `relationship=${anchor.relationship}`,
          `localState=${anchor.localState}`,
          `cited=${anchor.citedPath}@${anchor.citedCommitOid}`,
          `citedDeclarationChunkOrdinal=${anchor.citedDeclarationChunkOrdinal ?? "none"}`,
          `citedDeclarationContextSha256=${anchor.citedDeclarationContextSha256 ?? "none"}`,
          `validated=${anchor.validatedPath ?? "none"}@${anchor.validatedCommitOid ?? "none"}`,
        ].join(" "),
        800,
      ),
    });
  }
  const selectedEvidence = evidence.slice(0, maximumEvidenceItems);
  const evidenceText = selectedEvidence
    .map((item) => `[${item.id} ${item.kind}] ${item.text}`)
    .join("\n");
  return {
    evidence: selectedEvidence,
    prompt: [
      "Answer the question using only the authorized evidence below.",
      "Current-revision Code is authoritative for what exists now.",
      "Reviewed Memory is authoritative only for recorded rationale or history.",
      "If Memory conflicts with current Code or an anchor is stale, state the conflict explicitly.",
      "A claim comparing historical Memory with current Code must cite the relevant anchor ID too.",
      "If the evidence is insufficient, abstain.",
      "Return strict JSON with this shape:",
      '{"answer":"concise English answer","abstain":false,"claims":[{"text":"one factual claim","citations":["M1","C1"]}]}',
      "Every factual claim must cite one or more evidence IDs. Never invent an ID.",
      "",
      `Question: ${packet.query}`,
      `Requested commit: ${packet.receipt.requestedCommitOid ?? "none"}`,
      `Route: ${packet.deliveredRoute}`,
      "Evidence:",
      evidenceText || "(none)",
    ].join("\n"),
  };
}

export function scoreJointReaderOutput(input: {
  evidence: readonly JointReaderEvidenceItem[];
  expectation: JointReaderExpectation;
  output: JointReaderOutput;
}): JointReaderScore {
  const normalizedAnswer = input.output.answer.toLocaleLowerCase();
  const evidenceKindById = new Map(input.evidence.map((item) => [item.id, item.kind]));
  const citations = input.output.claims.flatMap((claim) => claim.citations);
  const citedKinds = new Set(
    citations.flatMap((citation) => {
      const kind = evidenceKindById.get(citation);
      return kind ? [kind] : [];
    }),
  );
  return {
    abstentionCorrect: input.output.abstain === input.expectation.abstain,
    citationCompleteness:
      input.output.abstain ||
      (input.output.claims.length > 0 &&
        input.output.claims.every((claim) => claim.text.trim() && claim.citations.length > 0)),
    citationIdsValid: citations.every((citation) => evidenceKindById.has(citation)),
    forbiddenTermsAbsent: (input.expectation.forbiddenTerms ?? []).every(
      (term) => !normalizedAnswer.includes(term.toLocaleLowerCase()),
    ),
    requiredCitationKindsPresent: (input.expectation.requiredCitationKinds ?? []).every((kind) =>
      citedKinds.has(kind),
    ),
    requiredTermsPresent: (input.expectation.requiredTerms ?? []).every((term) =>
      normalizedAnswer.includes(term.toLocaleLowerCase()),
    ),
  };
}
