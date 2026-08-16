import { expect, test } from "vitest";
import {
  assembleGroupedJointEvidence,
  planJointEvidenceRoute,
} from "@/lib/joint-memory-code-prototype";
import { buildJointReaderPrompt } from "@/lib/joint-memory-code-reader-prototype";

test("reader evidence centers a bounded Code passage around the retrieval match", () => {
  const matchText = "submit_memory_proposal";
  const packet = assembleGroupedJointEvidence({
    query: "Does proposal submission still insert directly?",
    plan: planJointEvidenceRoute({
      query: "Does proposal submission still insert directly into memory_proposals?",
      hasRepositoryContext: true,
    }),
    code: [
      {
        artifactId: "artifact-1",
        commitOid: "a".repeat(40),
        content: `${"before ".repeat(600)}SELECT * FROM lore.${matchText}($1);${" after".repeat(600)}`,
        contentSha256: "b".repeat(64),
        matchText,
        path: "src/lib/memory.ts",
        score: 1,
        symbol: "createMemoryModule.propose",
      },
    ],
    requestedCommitOid: "a".repeat(40),
  });

  const result = buildJointReaderPrompt(packet);
  const codeEvidence = result.evidence.find((item) => item.id === "C1");
  expect(codeEvidence?.text).toContain(matchText);
  expect(codeEvidence?.text.length).toBeLessThanOrEqual(1_800);
  expect(codeEvidence?.text).toMatch(/^src\/lib\/memory\.ts @ /);
});
