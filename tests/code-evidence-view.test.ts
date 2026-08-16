import { expect, test } from "vitest";
import type { MemoryCodeEvidence as ServerMemoryCodeEvidence } from "@/lib/code-evidence";
import {
  codeEvidenceSectionState,
  shortCommitOid,
  summarizeCodeEvidence,
} from "@/lib/code-evidence-view";
import type { CodeIndexJob as ServerCodeIndexJob } from "@/lib/code-index";
import type { CodeEvidenceValidationState, CodeIndexJob, MemoryCodeEvidence } from "@/lib/types";

const MEMORY_ID = "40000000-0000-4000-8000-000000000001";

function citation(
  index: number,
  validationState: CodeEvidenceValidationState,
  overrides: Partial<MemoryCodeEvidence> = {},
): MemoryCodeEvidence {
  return {
    id: `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    memoryId: MEMORY_ID,
    repositoryId: "70000000-0000-4000-8000-000000000001",
    citedRevisionId: "70000000-0000-4000-8000-000000000002",
    citedGenerationId: "70000000-0000-4000-8000-000000000003",
    citedArtifactId: "70000000-0000-4000-8000-000000000004",
    citedCommitOid: "a".repeat(40),
    citedPath: `src/module-${index}.ts`,
    citedSymbolKey: `src/module-${index}.ts#guard`,
    citedDeclarationKey: `src/module-${index}.ts#guard`,
    citedDeclarationChunkOrdinal: 0,
    citedDeclarationContextSha256: "c".repeat(64),
    citedContentSha256: "d".repeat(64),
    relationship: "supports",
    validationState,
    validatedRevisionId: null,
    validatedGenerationId: null,
    validatedArtifactId: null,
    validatedCommitOid: null,
    validatedPath: null,
    createdByUserId: "10000000-0000-4000-8000-000000000001",
    createdByAgentId: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    validatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

// The browser mirrors in src/lib/types.ts must stay structurally assignable to
// the server contracts they render, or the UI would silently drift from the
// module that produces the data.
test("browser Code contracts stay assignable to the server modules", () => {
  const evidence: ServerMemoryCodeEvidence = citation(1, "current");
  const mirroredEvidence: MemoryCodeEvidence = evidence;
  const job: CodeIndexJob = {
    id: "80000000-0000-4000-8000-000000000001",
    repositoryId: "70000000-0000-4000-8000-000000000001",
    repositoryKey: "corespeed/lore",
    commitOid: "b".repeat(40),
    sourceRef: null,
    indexerRevision: "code-index-v1",
    status: "succeeded",
    attemptCount: 1,
    maximumAttempts: 5,
    availableAt: "2026-08-15T00:00:00.000Z",
    completedAt: "2026-08-15T00:01:00.000Z",
    lastError: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:01:00.000Z",
  };
  const mirroredJob: ServerCodeIndexJob = job;
  expect(mirroredEvidence.validationState).toBe("current");
  expect(mirroredJob.status).toBe("succeeded");
});

test("drift states a reader must not miss rank ahead of settled citations", () => {
  const summary = summarizeCodeEvidence([
    citation(1, "current"),
    citation(2, "moved"),
    citation(3, "changed"),
    citation(4, "unverifiable"),
    citation(5, "deleted"),
    citation(6, "ambiguous"),
  ]);

  // Alert first, then unknown, notice, and settled; inside a tone the order is
  // the deterministic cited path (module-3, module-5, module-6).
  expect(summary.rows.map((row) => row.stateLabel)).toEqual([
    "changed",
    "deleted",
    "ambiguous",
    "unverifiable",
    "moved",
    "current",
  ]);
  expect(summary.rows.slice(0, 3).every((row) => row.tone === "alert")).toBe(true);
  expect(summary.attentionCount).toBe(3);
  expect(summary.attentionMessage).toBe("3 of 6 code citations no longer match the cited code.");
});

test("every citation states its condition in words, never color alone", () => {
  const states: CodeEvidenceValidationState[] = [
    "ambiguous",
    "changed",
    "current",
    "deleted",
    "moved",
    "unverifiable",
  ];
  const summary = summarizeCodeEvidence(states.map((state, index) => citation(index, state)));
  for (const row of summary.rows) {
    expect(row.stateLabel).toBeTruthy();
    expect(row.stateDescription.length).toBeGreaterThan(20);
    expect(row.relationshipDescription).toBeTruthy();
  }
});

test("a single stale citation reads in the singular", () => {
  const summary = summarizeCodeEvidence([citation(1, "deleted")]);
  expect(summary.attentionMessage).toBe("1 of 1 code citation no longer matches the cited code.");
});

test("settled citations produce no attention notice", () => {
  const summary = summarizeCodeEvidence([
    citation(1, "current"),
    citation(2, "moved"),
    citation(3, "unverifiable"),
  ]);
  expect(summary.attentionCount).toBe(0);
  expect(summary.attentionMessage).toBeNull();
});

test("no visible citation produces an empty summary rather than a notice", () => {
  const summary = summarizeCodeEvidence([]);
  expect(summary).toEqual({ rows: [], total: 0, attentionCount: 0, attentionMessage: null });
});

test("the locator falls back from declaration to symbol to the cited file", () => {
  const [declaration] = summarizeCodeEvidence([citation(1, "current")]).rows;
  const [symbol] = summarizeCodeEvidence([
    citation(2, "current", { citedDeclarationKey: null }),
  ]).rows;
  const [file] = summarizeCodeEvidence([
    citation(3, "current", { citedDeclarationKey: null, citedSymbolKey: null }),
  ]).rows;

  expect(declaration?.locator).toBe("src/module-1.ts#guard");
  expect(symbol?.locator).toBe("src/module-2.ts#guard");
  expect(file?.locator).toBe("src/module-3.ts");
});

test("a moved citation reports its new path; the validated commit always shows", () => {
  const [moved] = summarizeCodeEvidence([
    citation(1, "moved", {
      validatedPath: "src/renamed.ts",
      validatedCommitOid: "e".repeat(40),
    }),
  ]).rows;
  const [current] = summarizeCodeEvidence([
    citation(2, "current", {
      validatedPath: "src/module-2.ts",
      validatedCommitOid: "a".repeat(40),
    }),
  ]).rows;

  expect(moved?.movedToPath).toBe("src/renamed.ts");
  expect(moved?.validatedCommitOid).toBe("e".repeat(40));
  expect(current?.movedToPath).toBeNull();
  // Equal cited/validated commits are still shown: hiding the equal case hid
  // the only clue that no independent recheck ever happened.
  expect(current?.validatedCommitOid).toBe("a".repeat(40));
});

test("commit OIDs are abbreviated for display without losing the stored value", () => {
  const [row] = summarizeCodeEvidence([citation(1, "current")]).rows;
  expect(shortCommitOid(row?.citedCommitOid ?? "")).toBe("aaaaaaaaaaaa");
  expect(row?.citedCommitOid).toHaveLength(40);
});

test("the citation view model exposes no filesystem location", () => {
  const summary = summarizeCodeEvidence([citation(1, "changed")]);
  const serialized = JSON.stringify(summary);
  expect(serialized).not.toMatch(/repositoryPath/i);
  expect(serialized).not.toMatch(/(^|[^a-z])\/(Users|home|var|tmp)\//i);
  for (const row of summary.rows) {
    expect(Object.keys(row)).not.toContain("repositoryPath");
    expect(row.citedPath.startsWith("/")).toBe(false);
  }
});

test("the citation section is absent for a Memory that cites no code", () => {
  // Most Memories never cite code; a permanent empty row would be dead chrome.
  expect(codeEvidenceSectionState({ hasError: false, total: 0 })).toBe("hidden");
  expect(codeEvidenceSectionState({ hasError: false, total: 1 })).toBe("list");
});

test("an unreadable citation list is reported, never silently hidden", () => {
  // Absent and unreadable are different: hiding a failed read could hide drift
  // on a Memory that does cite code.
  expect(codeEvidenceSectionState({ hasError: true, total: 0 })).toBe("error");
});

test("a failed refresh keeps the last successful read on screen", () => {
  // Cached citations (drift included) beat an error row; SWR keeps stale data
  // on a failed background revalidation and the view must not discard it.
  expect(codeEvidenceSectionState({ hasError: true, total: 3 })).toBe("list");
});
