import type { CodeIndexJob, CodeIndexJobStatus } from "./types";

/**
 * Presentation model for Code Index jobs in the operator surface.
 *
 * An operator enqueues an exact commit and needs to know whether it landed.
 * `dead` is the queue's terminal-failure state after `maximumAttempts`; it is
 * the one status that always needs a human. Job rows carry `repositoryKey` and
 * a commit OID only — the operator-configured `repositoryPath` never leaves the
 * server.
 */
export type CodeIndexJobTone = "failed" | "neutral" | "ok" | "running";

/**
 * Queue semantics map onto the Workspace's existing status-badge tones rather
 * than introducing new colors. `processing` and `cancelled` therefore share the
 * neutral badge and are told apart by their words, which is how Lore keeps color
 * scarce.
 */
const BADGE_TONE: Record<CodeIndexJobTone, "neutral" | "ok" | "unready"> = {
  failed: "unready",
  running: "neutral",
  neutral: "neutral",
  ok: "ok",
};

interface CodeIndexJobStatusPresentation {
  tone: CodeIndexJobTone;
  description: string;
}

const STATUS_PRESENTATION: Record<CodeIndexJobStatus, CodeIndexJobStatusPresentation> = {
  pending: { tone: "running", description: "Queued and waiting for a maintenance worker." },
  processing: { tone: "running", description: "A maintenance worker holds the lease." },
  succeeded: { tone: "ok", description: "The revision is indexed and its generation is active." },
  dead: {
    tone: "failed",
    description: "Every attempt failed. Lore stopped retrying this revision.",
  },
  cancelled: { tone: "neutral", description: "Superseded before it ran." },
};

const TONE_ORDER: Record<CodeIndexJobTone, number> = {
  failed: 0,
  running: 1,
  neutral: 2,
  ok: 3,
};

export interface CodeIndexJobRow {
  id: string;
  repositoryKey: string;
  shortCommitOid: string;
  sourceRef: string | null;
  status: CodeIndexJobStatus;
  tone: CodeIndexJobTone;
  /** Modifier for the Workspace's existing `operations-status` badge. */
  badgeTone: "neutral" | "ok" | "unready";
  statusDescription: string;
  attempts: string;
  lastError: string | null;
  indexerRevision: string;
  createdAt: string;
  completedAt: string | null;
}

export interface CodeIndexJobSummary {
  rows: CodeIndexJobRow[];
  total: number;
  failedCount: number;
  runningCount: number;
}

function toRow(job: CodeIndexJob): CodeIndexJobRow {
  const status = STATUS_PRESENTATION[job.status];
  return {
    id: job.id,
    repositoryKey: job.repositoryKey,
    shortCommitOid: job.commitOid.slice(0, 12),
    sourceRef: job.sourceRef,
    status: job.status,
    tone: status.tone,
    badgeTone: BADGE_TONE[status.tone],
    statusDescription: status.description,
    attempts: `${job.attemptCount}/${job.maximumAttempts}`,
    lastError: job.lastError,
    indexerRevision: job.indexerRevision,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
  };
}

/**
 * Rank failures first, then work still in flight, so an operator sees the jobs
 * that need them before the settled history. Newest-first inside each tone
 * preserves the server's ordering.
 */
export function summarizeCodeIndexJobs(jobs: readonly CodeIndexJob[]): CodeIndexJobSummary {
  const rows = jobs.map(toRow);
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort(
      (left, right) =>
        TONE_ORDER[left.row.tone] - TONE_ORDER[right.row.tone] || left.index - right.index,
    )
    .map((entry) => entry.row);
  return {
    rows: ordered,
    total: ordered.length,
    failedCount: ordered.filter((row) => row.tone === "failed").length,
    runningCount: ordered.filter((row) => row.tone === "running").length,
  };
}
