export const RETRIEVAL_FEEDBACK_CANDIDATE_POLICY = {
  revision: "iterative-tail-reserve-v3",
  targetShare: 0.2,
  minimumSlots: 1,
} as const;

export const RETRIEVAL_EVIDENCE_POLICY = {
  revision: "compact-rerank-expanded-answer-v1",
  rerankPassage: "best-chunk-with-configured-neighbors",
  answerEvidence: "bounded-top-chunks-with-whole-small-memory",
} as const;

/**
 * How the semantic channel finds a Workspace's nearest chunks. Below
 * `exactScanLimit` vectors of the generation it compares every one (exact, and
 * cheap at that size); from there on the host may answer from an approximate index,
 * and must fall back to the exact comparison when that answer could be short.
 */
export const RETRIEVAL_SEMANTIC_POLICY = {
  revision: "exact-below-limit-approximate-above-v1",
  exactScanLimit: 20_000,
} as const;

/**
 * The relaxed lexical channel's term budget (schema revision 25). A query of more
 * than `maximumTerms` terms keeps the `maximumTerms` found in the fewest of the first
 * `sampleChunks` visible chunks, in (memory_id, ordinal) order; heavier terms, then
 * term text, break ties. The host function hard-codes both numbers; the reference
 * statement in `./testing` reads them.
 */
export const RETRIEVAL_RELAXED_TERM_POLICY = {
  revision: "rarest-six-of-visible-sample-v1",
  maximumTerms: 6,
  sampleChunks: 1000,
} as const;

export const RETRIEVAL_ENTITY_ALIAS_POLICY = {
  revision: "deterministic-exact-alias-rrf-v1",
  candidateGeneration: "independent-rls-filtered-chunk-channel",
  maximumQueryAliases: 8,
  reference: {
    title: "Multi-step Entity-centric Information Retrieval for Multi-Hop Question Answering",
    doi: "https://doi.org/10.18653/v1/D19-5816",
  },
} as const;

export const RETRIEVAL_CJK_LEXICAL_POLICY = {
  revision: "deterministic-cjk-substring-rrf-v1",
  candidateGeneration: "independent-rls-filtered-substring-channel",
  gramCodePoints: 3,
  maximumQueryGrams: 24,
} as const;

export const RETRIEVAL_CONTEXT_GROUP_POLICY = {
  revision: "explicit-natural-boundary-append-v3",
  defaultBaseCandidateLimit: 20,
  defaultMaximumGroups: 3,
  maximumFetchedMemories: 800,
  provenance: {
    relationship: "Lore adaptation using only caller-supplied source structure",
    title: "HiGMem: Hierarchical Memory for Long-Term Conversational Agents",
    paper: "https://aclanthology.org/2026.findings-acl.1690/",
  },
} as const;
