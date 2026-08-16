import { expect, test } from "vitest";
import { summarizeCodeIndexJobs } from "@/lib/code-index-job-view";
import type { CodeIndexJob, CodeIndexJobStatus } from "@/lib/types";

function job(
  index: number,
  status: CodeIndexJobStatus,
  overrides: Partial<CodeIndexJob> = {},
): CodeIndexJob {
  return {
    id: `80000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    repositoryId: "70000000-0000-4000-8000-000000000001",
    repositoryKey: "corespeed/lore",
    commitOid: String(index).repeat(40).slice(0, 40),
    sourceRef: null,
    indexerRevision: "code-index-v1",
    status,
    attemptCount: status === "dead" ? 5 : 1,
    maximumAttempts: 5,
    availableAt: "2026-08-15T00:00:00.000Z",
    completedAt: status === "succeeded" ? "2026-08-15T00:01:00.000Z" : null,
    lastError: status === "dead" ? "Git object 1111 is unreachable" : null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:01:00.000Z",
    ...overrides,
  };
}

test("failed jobs rank first, then work still in flight, then settled history", () => {
  const summary = summarizeCodeIndexJobs([
    job(1, "succeeded"),
    job(2, "cancelled"),
    job(3, "pending"),
    job(4, "dead"),
    job(5, "processing"),
  ]);

  expect(summary.rows.map((row) => row.status)).toEqual([
    "dead",
    "pending",
    "processing",
    "cancelled",
    "succeeded",
  ]);
  expect(summary.total).toBe(5);
  expect(summary.failedCount).toBe(1);
  expect(summary.runningCount).toBe(2);
});

test("newest-first server order is preserved inside each tone", () => {
  const summary = summarizeCodeIndexJobs([
    job(1, "pending"),
    job(2, "dead"),
    job(3, "pending"),
    job(4, "dead"),
  ]);
  expect(summary.rows.map((row) => row.id)).toEqual([
    job(2, "dead").id,
    job(4, "dead").id,
    job(1, "pending").id,
    job(3, "pending").id,
  ]);
});

test("every queue status carries an operator-readable explanation", () => {
  const statuses: CodeIndexJobStatus[] = [
    "cancelled",
    "dead",
    "pending",
    "processing",
    "succeeded",
  ];
  const summary = summarizeCodeIndexJobs(statuses.map((status, index) => job(index, status)));
  for (const row of summary.rows) {
    expect(row.statusDescription.length).toBeGreaterThan(20);
    expect(row.attempts).toMatch(/^\d+\/\d+$/);
  }
});

test("a dead job surfaces its attempt budget and last error", () => {
  const [row] = summarizeCodeIndexJobs([job(1, "dead")]).rows;
  expect(row?.tone).toBe("failed");
  expect(row?.attempts).toBe("5/5");
  expect(row?.lastError).toBe("Git object 1111 is unreachable");
});

test("an empty queue summarizes to zero rather than a failure", () => {
  expect(summarizeCodeIndexJobs([])).toEqual({
    rows: [],
    total: 0,
    failedCount: 0,
    runningCount: 0,
  });
});

test("job rows identify a repository by key and commit, never by filesystem path", () => {
  const summary = summarizeCodeIndexJobs([job(1, "succeeded"), job(2, "dead")]);
  const serialized = JSON.stringify(summary);
  expect(serialized).not.toMatch(/repositoryPath/i);
  expect(serialized).not.toMatch(/(^|[^a-z])\/(Users|home|var|tmp)\//i);
  for (const row of summary.rows) {
    expect(Object.keys(row)).not.toContain("repositoryPath");
    expect(row.repositoryKey).toBe("corespeed/lore");
    expect(row.shortCommitOid).toHaveLength(12);
  }
});
