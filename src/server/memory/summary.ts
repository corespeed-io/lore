// Layer 2: the rolling thread summary. It carries CURRENT STATE, not a
// narration of every turn — "the goal is X" rather than "the user asked about
// X, then the assistant suggested Y, then…".
//
// Three properties make it trustworthy:
//   - Incremental: version N+1 is (version N) + (events after its covered
//     range). Nothing re-reads the whole thread.
//   - Versioned: every version is kept, so a wrong summary is debuggable and a
//     regression test can pin one.
//   - Reproducible: the covered range is recorded, so the same summarizer over
//     the same inputs must produce the same summary. Tests use a deterministic
//     fake for exactly this reason.
//
// The summarizer is an interface. Whatever model a deployment uses lives behind
// it, and nothing else in the memory system knows a model exists.

import type { Db } from "../db";
import type { ConversationEvent } from "./events";
import { getConversationEvents, getThread } from "./events";

export interface Decision {
  value: string;
  status: "confirmed" | "proposed" | "rejected";
}

export interface Correction {
  old: string;
  new: string;
}

export interface Artifact {
  name: string;
  reference: string;
  type: string;
}

// Current state, field by field. An assistant suggestion is a `proposed`
// decision; only the user can make one `confirmed`.
export interface StructuredSummary {
  goal: string;
  background: string[];
  requirements: string[];
  constraints: string[];
  decisions: Decision[];
  corrections: Correction[];
  completed: string[];
  artifacts: Artifact[];
  open_questions: string[];
  blockers: string[];
  next_action: string;
}

export const EMPTY_SUMMARY: StructuredSummary = {
  goal: "",
  background: [],
  requirements: [],
  constraints: [],
  decisions: [],
  corrections: [],
  completed: [],
  artifacts: [],
  open_questions: [],
  blockers: [],
  next_action: "",
};

export interface SummarizerInput {
  previous: StructuredSummary;
  events: ConversationEvent[];
}

// Provider-independent by construction. A deployment plugs in whatever model it
// has; the rest of the memory system never learns one exists.
export interface Summarizer {
  readonly version: string;
  summarize(input: SummarizerInput): Promise<StructuredSummary>;
}

export interface ThreadSummary {
  id: string;
  thread_id: string;
  version: number;
  covered_from_sequence: number;
  covered_through_sequence: number;
  structured_summary: StructuredSummary;
  rendered_summary: string;
  summarizer_version: string;
  created_at: string;
  superseded_at: string | null;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function rowToSummary(r: Record<string, unknown>): ThreadSummary {
  return {
    id: String(r.id),
    thread_id: String(r.thread_id),
    version: Number(r.version),
    covered_from_sequence: Number(r.covered_from_sequence),
    covered_through_sequence: Number(r.covered_through_sequence),
    structured_summary: r.structured_summary as StructuredSummary,
    rendered_summary: String(r.rendered_summary),
    summarizer_version: String(r.summarizer_version),
    created_at: iso(r.created_at),
    superseded_at: r.superseded_at ? iso(r.superseded_at) : null,
  };
}

// One deterministic rendering, so the same structured summary always produces
// the same text and a diff between versions is meaningful. Empty sections are
// omitted rather than printed blank.
export function renderSummary(s: StructuredSummary): string {
  const out: string[] = [];
  const list = (heading: string, items: string[]) => {
    if (items.length) out.push(`## ${heading}\n${items.map((i) => `- ${i}`).join("\n")}`);
  };
  if (s.goal) out.push(`## Goal\n${s.goal}`);
  list("Background", s.background);
  list("Requirements", s.requirements);
  list("Constraints", s.constraints);
  if (s.decisions.length) {
    out.push(`## Decisions\n${s.decisions.map((d) => `- [${d.status}] ${d.value}`).join("\n")}`);
  }
  if (s.corrections.length) {
    out.push(`## Corrections\n${s.corrections.map((c) => `- ${c.old} -> ${c.new}`).join("\n")}`);
  }
  list("Completed", s.completed);
  if (s.artifacts.length) {
    out.push(
      `## Artifacts\n${s.artifacts.map((a) => `- ${a.name} (${a.type}): ${a.reference}`).join("\n")}`,
    );
  }
  list("Open questions", s.open_questions);
  list("Blockers", s.blockers);
  if (s.next_action) out.push(`## Next action\n${s.next_action}`);
  return out.join("\n\n");
}

export interface RefreshResult {
  summary: ThreadSummary | null;
  /** True when there were no new events, so the active summary still stands. */
  unchanged: boolean;
}

// Fold the events since the active summary's covered range into a new version.
// The previous version is marked superseded in the same transaction, so there is
// never a moment with two active summaries.
export async function refreshThreadSummary(
  db: Db,
  summarizer: Summarizer,
  threadId: string,
): Promise<RefreshResult> {
  const thread = await getThread(db, threadId);
  if (!thread) throw new Error(`not_found: thread ${threadId}`);

  const activeRes = await db.query(
    "SELECT * FROM thread_summaries WHERE thread_id = $1 AND superseded_at IS NULL",
    [threadId],
  );
  const active = activeRes.rows[0] ? rowToSummary(activeRes.rows[0]) : null;
  const from = active?.covered_through_sequence ?? 0;
  const events = await getConversationEvents(db, { threadId, fromSequence: from, limit: 1000 });
  if (events.length === 0) return { summary: active, unchanged: true };

  const structured = await summarizer.summarize({
    previous: active?.structured_summary ?? EMPTY_SUMMARY,
    events,
  });
  const through = events[events.length - 1].sequence;
  const version = (active?.version ?? 0) + 1;
  const id = crypto.randomUUID();

  return db.tx(async (q) => {
    // Retire the old version first: the partial unique index allows exactly one
    // active summary per thread, so this ordering is what keeps the insert legal.
    await q(
      "UPDATE thread_summaries SET superseded_at = now() WHERE thread_id = $1 AND superseded_at IS NULL",
      [threadId],
    );
    const ins = await q(
      `INSERT INTO thread_summaries
         (id, thread_id, version, covered_from_sequence, covered_through_sequence,
          structured_summary, rendered_summary, summarizer_version)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *`,
      [
        id,
        threadId,
        version,
        from + 1,
        through,
        JSON.stringify(structured),
        renderSummary(structured),
        summarizer.version,
      ],
    );
    await q("UPDATE threads SET last_summary_sequence = $1, updated_at = now() WHERE id = $2", [
      through,
      threadId,
    ]);
    return { summary: rowToSummary(ins.rows[0]), unchanged: false };
  });
}

export async function getActiveThreadSummary(
  db: Db,
  threadId: string,
): Promise<ThreadSummary | null> {
  const res = await db.query(
    "SELECT * FROM thread_summaries WHERE thread_id = $1 AND superseded_at IS NULL",
    [threadId],
  );
  return res.rows[0] ? rowToSummary(res.rows[0]) : null;
}

export async function getThreadSummaryHistory(db: Db, threadId: string): Promise<ThreadSummary[]> {
  const res = await db.query(
    "SELECT * FROM thread_summaries WHERE thread_id = $1 ORDER BY version DESC",
    [threadId],
  );
  return res.rows.map(rowToSummary);
}
