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
  return renderToStaticMarkup(
    <SWRConfig
      value={{
        fallback: {
          [unstable_serialize(loreKeys.memoryCodeEvidence(WORKSPACE_ID, MEMORY_ID))]: evidence,
        },
        provider: () => new Map(),
      }}
    >
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
  // Bob is a co-member who cannot see Alice's private Memory citation, so his
  // RLS-filtered read returns an empty list.
  const markup = renderMemoryView([]);

  expect(markup).toContain("Code citations");
  expect(markup).toContain("No code citations");
  expect(markup).not.toContain("code-evidence-notice");
  expect(markup).not.toContain("code-evidence-state-alert");
  expect(markup).not.toContain("src/module-1.ts");
  expect(markup).not.toContain("ab12cd34ef56");
  expect(markup).not.toMatch(/no longer match/);
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

test("an unread citation list renders a loading state instead of an empty one", () => {
  const markup = renderMemoryView(undefined);

  expect(markup).toContain("Loading code citations…");
  expect(markup).not.toContain("No code citations");
  expect(markup).not.toContain("code-evidence-notice");
});
