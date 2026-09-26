import { expect, test } from "vitest";
import {
  RETRIEVAL_KNOBS,
  retrievalKnobsFromEnvironment,
  strictRetrievalKnobsFromEnvironment,
} from "@/server/providers/retrieval-knobs";

test("a benchmark's default knobs are the deployment defaults", () => {
  const defaults = strictRetrievalKnobsFromEnvironment({});
  expect(defaults).toEqual(retrievalKnobsFromEnvironment({}).knobs);
  for (const [key, spec] of Object.entries(RETRIEVAL_KNOBS)) {
    expect(defaults[key as keyof typeof defaults], key).toBe(spec.fallback);
  }
  expect(defaults.entityAliasRecall).toBe(false);
});

test("the server tolerates what a benchmark refuses", () => {
  // The candidate limit is lenient on the server (clamp or default, no warning).
  const lenient = retrievalKnobsFromEnvironment({ LORE_RERANK_CANDIDATE_LIMIT: "201" });
  expect(lenient.knobs.rerankCandidateLimit).toBe(200);
  expect(lenient.problems).toEqual([expect.objectContaining({ warn: false })]);
  expect(() => strictRetrievalKnobsFromEnvironment({ LORE_RERANK_CANDIDATE_LIMIT: "201" })).toThrow(
    "LORE_RERANK_CANDIDATE_LIMIT must be at most 200",
  );

  const invalid = retrievalKnobsFromEnvironment({ LORE_RERANK_WEIGHT: "2" });
  expect(invalid.knobs.rerankWeight).toBe(1);
  expect(invalid.problems).toEqual([expect.objectContaining({ warn: true })]);
  expect(() => strictRetrievalKnobsFromEnvironment({ LORE_RERANK_WEIGHT: "2" })).toThrow(
    "LORE_RERANK_WEIGHT must be between 0 and 1",
  );
  expect(() => strictRetrievalKnobsFromEnvironment({ LORE_ENTITY_ALIAS_RECALL: "maybe" })).toThrow(
    "LORE_ENTITY_ALIAS_RECALL",
  );
});

test("valid values pass through unchanged", () => {
  expect(
    strictRetrievalKnobsFromEnvironment({
      LORE_EVIDENCE_NEIGHBOR_CHUNKS: "2",
      LORE_QUERY_PLANNER_MAX_QUERIES: "5",
      LORE_RERANK_CANDIDATE_LIMIT: "120",
      LORE_SEMANTIC_DISTANCE_THRESHOLD: "0.75",
      LORE_ENTITY_ALIAS_RECALL: "true",
    }),
  ).toMatchObject({
    evidenceNeighborChunks: 2,
    queryPlannerMaxQueries: 5,
    rerankCandidateLimit: 120,
    semanticDistanceThreshold: 0.75,
    entityAliasRecall: true,
  });
});
