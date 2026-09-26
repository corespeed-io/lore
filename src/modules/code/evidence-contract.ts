/**
 * The Memory Code Evidence vocabulary, shared by citation, Proposal snapshots, and
 * the published contract. The SQL enums of the same names must match
 * (tests/server/schema-drift.test.ts).
 */
export const CODE_EVIDENCE_RELATIONSHIPS = [
  "supports",
  "contradicts",
  "implements",
  "rationale",
] as const;
export type CodeEvidenceRelationship = (typeof CODE_EVIDENCE_RELATIONSHIPS)[number];

export const CODE_EVIDENCE_VALIDATION_STATES = [
  "current",
  "moved",
  "changed",
  "deleted",
  "ambiguous",
  "unverifiable",
] as const;
export type CodeEvidenceValidationState = (typeof CODE_EVIDENCE_VALIDATION_STATES)[number];

export function isCodeEvidenceRelationship(value: unknown): value is CodeEvidenceRelationship {
  return CODE_EVIDENCE_RELATIONSHIPS.includes(value as CodeEvidenceRelationship);
}

export const CODE_EVIDENCE_RELATIONSHIP_MESSAGE = `relationship must be ${CODE_EVIDENCE_RELATIONSHIPS.slice(0, -1).join(", ")}, or ${CODE_EVIDENCE_RELATIONSHIPS.at(-1)}`;
