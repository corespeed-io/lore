import type { PostgresDatabase } from "@corespeed/lore-core";
import { expect, test } from "vitest";
import {
  CodeEvidenceValidationError,
  createCodeEvidenceModule,
  MAXIMUM_ASSESSED_CITATION_MEMORIES,
  MAXIMUM_ASSESSED_CITATIONS,
} from "@/modules/code/evidence";
import {
  aggregateContextualImpact,
  type ContextualImpactAssessment,
  type ContextualImpactState,
} from "@/modules/context/policy";

const ACTOR = {
  workspaceId: "20000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000001",
};

const unreachableDatabase: PostgresDatabase = {
  transaction: () => {
    throw new Error("a rejected batch must not open a transaction");
  },
};

const memoryId = (index: number) => `40000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;

test("batched anchor assessment rejects unbounded batches before reading anything", async () => {
  const evidence = createCodeEvidenceModule(unreachableDatabase);
  const batch = (memoryIds: readonly string[], limit: number, commitOid = "a".repeat(40)) =>
    evidence.assessMemoryCitations(ACTOR, {
      memoryIds,
      repositoryKey: "corespeed/lore",
      commitOid,
      limit,
    });
  const tooMany = Array.from({ length: MAXIMUM_ASSESSED_CITATION_MEMORIES + 1 }, (_, index) =>
    memoryId(index),
  );

  await expect(batch(tooMany, 10)).rejects.toThrow(
    `memoryIds may contain at most ${MAXIMUM_ASSESSED_CITATION_MEMORIES} UUIDs`,
  );
  for (const limit of [0, MAXIMUM_ASSESSED_CITATIONS + 1, 1.5]) {
    await expect(batch([memoryId(1)], limit), String(limit)).rejects.toBeInstanceOf(
      CodeEvidenceValidationError,
    );
  }
  await expect(batch(["not-a-uuid"], 10)).rejects.toBeInstanceOf(CodeEvidenceValidationError);
  await expect(batch([memoryId(1)], 10, "abc1234")).rejects.toBeInstanceOf(
    CodeEvidenceValidationError,
  );
  // An empty batch is answered without a transaction.
  await expect(batch([], MAXIMUM_ASSESSED_CITATIONS)).resolves.toEqual([]);
});

test("the packet impact verdict takes the worst anchor and never calls nothing unaffected", () => {
  const anchor = (index: number, state: ContextualImpactState, changes: string[] = []) => ({
    anchorId: memoryId(index),
    assessment: { state, changes } satisfies ContextualImpactAssessment,
  });

  expect(
    aggregateContextualImpact(
      [
        anchor(1, "unaffected"),
        anchor(2, "possibly_affected", ["uncertain:calls:x"]),
        anchor(3, "affected", ["changed:calls:y"]),
      ],
      false,
    ),
  ).toEqual({
    state: "affected",
    changes: [`anchor:${memoryId(2)}:uncertain:calls:x`, `anchor:${memoryId(3)}:changed:calls:y`],
  });
  expect(
    aggregateContextualImpact([anchor(1, "unknown"), anchor(2, "possibly_affected")], false),
  ).toMatchObject({ state: "possibly_affected" });
  expect(aggregateContextualImpact([anchor(1, "unaffected")], false)).toEqual({
    state: "unaffected",
    changes: [],
  });
  // Unknown is never silent: it names why when no anchor reported a change.
  expect(aggregateContextualImpact([], false)).toEqual({
    state: "unknown",
    changes: ["not_assessed:no_resolvable_anchor_subject"],
  });
  expect(aggregateContextualImpact([anchor(1, "unknown")], false)).toEqual({
    state: "unknown",
    changes: ["assessment:unknown"],
  });
  // Comparing fewer anchors than were cited can never prove the packet unaffected.
  expect(aggregateContextualImpact([anchor(1, "unaffected")], true)).toEqual({
    state: "unknown",
    changes: ["anchors:truncated"],
  });
});
