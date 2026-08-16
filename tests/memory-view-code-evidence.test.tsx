import { renderToStaticMarkup } from "react-dom/server";
import { SWRConfig, unstable_serialize } from "swr";
import { expect, test } from "vitest";
import { MemoryView } from "@/components/MemoryView";
import { loreKeys } from "@/lib/lore-swr";
import type { CodeEvidenceValidationState, MemoryCodeEvidence } from "@/lib/types";

const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
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
    citedCommitOid: "ab12cd34ef56".padEnd(40, "0"),
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

/**
 * Render the Memory detail workspace with the Code Evidence the Actor's own
 * RLS-filtered read returned. Seeding the SWR cache is exactly what the
 * transport would have produced for that Actor, so an unauthorized citation is
 * modelled the only way it can reach the browser: as absent data.
 */
function renderMemoryView(evidence: readonly MemoryCodeEvidence[] | undefined): string {
  return renderMemoryViewWith({
    fallback: {
      [unstable_serialize(loreKeys.memoryCodeEvidence(WORKSPACE_ID, MEMORY_ID))]: evidence,
    },
    provider: () => new Map(),
  });
}

function renderMemoryViewWith(config: Record<string, unknown>): string {
  return renderToStaticMarkup(
    <SWRConfig value={config}>
      <MemoryView
        workspaceId={WORKSPACE_ID}
        title="Retrieval grounding gate"
        type="reference"
        id={MEMORY_ID}
        body="The gate is planned host-side."
        wikilinkTargets={{}}
        scope="private"
        ownerUserId="10000000-0000-4000-8000-000000000001"
        createdByAgentId={null}
        createdAt="2026-08-14T00:00:00.000Z"
        updatedAt="2026-08-15T00:00:00.000Z"
        version={3}
        related={[]}
        backLabel="Memories"
        saving={false}
        error={null}
        onBack={() => {}}
        onOpen={() => {}}
        onLocalGraph={() => {}}
        onEdit={() => {}}
        onForget={() => {}}
      />
    </SWRConfig>,
  );
}

test("a Memory with drifted code citations makes the drift unmissable", () => {
  const markup = renderMemoryView([
    citation(1, "current"),
    citation(2, "changed"),
    citation(3, "deleted"),
  ]);

  expect(markup).toContain("Code citations");
  expect(markup).toContain("code-evidence-notice");
  expect(markup).toContain("2 of 3 code citations no longer match the cited code.");
  expect(markup).toContain("code-evidence-state-alert");
  expect(markup).toContain("The cited code changed after this Memory cited it.");
  expect(markup).toContain("The cited code no longer exists at the validated revision.");
  expect(markup).toContain("src/module-2.ts#guard");
  // The abbreviated commit is shown; nothing resembling a filesystem path is.
  expect(markup).toContain("ab12cd34ef56");
  expect(markup).not.toMatch(/repositoryPath/i);
});

test("a citation the Actor cannot read never renders", () => {
  // An Actor whose RLS-filtered read returns nothing gets no trace of the
  // citation — not its path, not its commit, not even the section heading.
  const markup = renderMemoryView([]);

  expect(markup).not.toContain("Code citations");
  expect(markup).not.toContain("code-evidence-notice");
  expect(markup).not.toContain("code-evidence-state-alert");
  expect(markup).not.toContain("src/module-1.ts");
  expect(markup).not.toContain("ab12cd34ef56");
  expect(markup).not.toMatch(/no longer match/);
  // The rest of the Memory detail is untouched.
  expect(markup).toContain("Retrieval grounding gate");
  expect(markup).toContain("Related");
});

test("a Memory that cites no code carries no citation section at all", () => {
  // Most Memories never cite code; an always-present empty section would be
  // dead chrome in every ordinary Memory's context column.
  expect(renderMemoryView([])).not.toContain("Code citations");
});

test("settled citations render without an attention notice", () => {
  const markup = renderMemoryView([citation(1, "current"), citation(2, "moved")]);

  // A settled anchor keeps the quiet badge; only drift tints one.
  expect(markup).toContain("code-evidence-state-ok");
  expect(markup).toContain("code-evidence-state-notice");
  expect(markup).toContain("The cited code is unchanged but now lives at a different path.");
  expect(markup).not.toContain("code-evidence-state-alert");
  expect(markup).not.toContain("code-evidence-notice");
  expect(markup).not.toMatch(/no longer match/);
});

test("an unread citation list stays silent until it resolves", () => {
  // No flicker: the section appears when data arrives, not before.
  const markup = renderMemoryView(undefined);

  expect(markup).not.toContain("Code citations");
  expect(markup).not.toContain("code-evidence-notice");
});
