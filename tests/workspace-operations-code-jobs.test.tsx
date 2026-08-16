import { renderToStaticMarkup } from "react-dom/server";
import { SWRConfig, unstable_serialize } from "swr";
import { expect, test } from "vitest";
import { WorkspaceOperationsView } from "@/components/WorkspaceOperationsView";
import { loreKeys } from "@/lib/lore-swr";
import type { CodeIndexJob, CodeIndexJobStatus } from "@/lib/types";

const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";

function job(
  index: number,
  status: CodeIndexJobStatus,
  overrides: Partial<CodeIndexJob> = {},
): CodeIndexJob {
  return {
    id: `80000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    repositoryId: "70000000-0000-4000-8000-000000000001",
    repositoryKey: "corespeed/lore",
    commitOid: "fe10dc32ba54".padEnd(40, "0"),
    sourceRef: null,
    indexerRevision: "code-index-v1",
    status,
    attemptCount: status === "dead" ? 5 : 1,
    maximumAttempts: 5,
    availableAt: "2026-08-15T00:00:00.000Z",
    completedAt: status === "succeeded" ? "2026-08-15T00:01:00.000Z" : null,
    lastError: status === "dead" ? "Git object is unreachable in the configured repository" : null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:01:00.000Z",
    ...overrides,
  };
}

function renderOperations(jobs: readonly CodeIndexJob[] | undefined): string {
  return renderToStaticMarkup(
    <SWRConfig
      value={{
        fallback: { [unstable_serialize(loreKeys.codeIndexJobs(WORKSPACE_ID, 20))]: jobs },
        provider: () => new Map(),
      }}
    >
      <WorkspaceOperationsView
        workspaceId={WORKSPACE_ID}
        workspaceName="Operations"
        onImportComplete={() => {}}
      />
    </SWRConfig>,
  );
}

test("an operator sees whether an enqueued commit landed", () => {
  const markup = renderOperations([
    job(1, "succeeded"),
    job(2, "dead"),
    job(3, "processing", { sourceRef: "refs/heads/main" }),
  ]);

  expect(markup).toContain("Code index jobs");
  expect(markup).toContain("1 failed · 3 recent");
  expect(markup).toContain("corespeed/lore");
  expect(markup).toContain("fe10dc32ba54");
  // Queue tones reuse the Workspace's existing status badges; `processing` and
  // `cancelled` share the neutral badge and are told apart by their words.
  expect(markup).toContain("operations-status-unready");
  expect(markup).toContain("operations-status-neutral");
  expect(markup).toContain("operations-status-ok");
  expect(markup).not.toContain("operations-status-failed");
  expect(markup).not.toContain("operations-status-running");
  // Attempt budget and the queue's own error text are the operator's diagnosis.
  expect(markup).toContain("5/5");
  expect(markup).toContain("Git object is unreachable in the configured repository");
  expect(markup).toContain("refs/heads/main");
});

test("the job surface never renders an operator-configured repository path", () => {
  const markup = renderOperations([job(1, "dead"), job(2, "succeeded")]);

  expect(markup).not.toMatch(/repositoryPath/i);
  expect(markup).not.toMatch(/(^|[^a-z])\/(Users|home|srv|var|tmp)\//i);
});

test("an empty queue reads as empty, not as a failure", () => {
  const markup = renderOperations([]);

  expect(markup).toContain("No index jobs have been enqueued in this Workspace.");
  expect(markup).toContain("0 recent");
  expect(markup).not.toContain("operations-status-unready");
});

test("an unread job list renders a loading state", () => {
  const markup = renderOperations(undefined);

  expect(markup).toContain("Loading index jobs…");
  expect(markup).not.toContain("No index jobs have been enqueued");
});
