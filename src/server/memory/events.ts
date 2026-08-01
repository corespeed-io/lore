// Layer 1: the immutable event log. This is the ground truth every other layer
// is derived from, which means two rules with no exceptions:
//
//   - Events are APPEND-ONLY. A correction is a new event, never an edit of an
//     old one, because a summary or a memory that cites event 7 must always be
//     able to read the event 7 it was built from.
//   - Ordering is deterministic. `sequence` is allocated under a row lock on
//     the thread, so two concurrent appends get 4 and 5 rather than both
//     believing they are 4.
//
// Append-only also means there is no delete path, which makes this the one place
// two rules have to be enforced rather than asked for politely:
//
//   - A secret that reaches this table can never be removed, and flows on into
//     summaries and the context pack. So content that trips the detector is
//     withheld WHOLE (see `withhold`), never partially rewritten.
//   - Only the user speaks for the user: extraction auto-commits `user_message`
//     at explicit trust, so a tool-sourced event may not carry a user-implied
//     type. Both rules live HERE because every writer — every tool, every
//     ingestion path, every future one — passes through this function.

import type { Db, Query } from "../db";
import { findSecretsInPayload } from "./safety";

export type EventType =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "agent_action"
  | "approval"
  | "artifact"
  | "system_observation";

export type ActorType = "user" | "assistant" | "tool" | "system";

export interface AppendEventArgs {
  threadId: string;
  eventType: EventType;
  // No actorType. It is DERIVED from the event type (see IMPLIED_ACTOR); an
  // optional override is a forgeable claim about who spoke, and the only reason
  // to send one is to say something the type does not.
  actorId?: string;
  content?: string;
  structuredPayload?: Record<string, unknown>;
  source?: string;
  traceId?: string;
  /** Replaying the same key on the same thread is a NOOP, not a second event. */
  idempotencyKey?: string;
}

export interface ConversationEvent {
  id: string;
  thread_id: string;
  sequence: number;
  event_type: EventType;
  actor_type: ActorType;
  actor_id: string | null;
  content: string;
  structured_payload: Record<string, unknown>;
  source: string | null;
  trace_id: string | null;
  created_at: string;
}

export interface AppendResult {
  event: ConversationEvent;
  /** True when an existing event was returned instead of a new one. */
  duplicate: boolean;
}

// Which actor an event type implies. Derived, never supplied, so a caller can
// neither label a user_message as coming from a tool nor label its own action as
// coming from the user. Exported because it is also the definition of "this type
// speaks for the user", which the tool surface has to honour.
export const IMPLIED_ACTOR: Record<EventType, ActorType> = {
  user_message: "user",
  assistant_message: "assistant",
  tool_call: "assistant",
  tool_result: "tool",
  agent_action: "assistant",
  approval: "user",
  artifact: "assistant",
  system_observation: "system",
};

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function rowToEvent(r: Record<string, unknown>): ConversationEvent {
  return {
    id: String(r.id),
    thread_id: String(r.thread_id),
    sequence: Number(r.sequence),
    event_type: r.event_type as EventType,
    actor_type: r.actor_type as ActorType,
    actor_id: r.actor_id === null || r.actor_id === undefined ? null : String(r.actor_id),
    content: String(r.content ?? ""),
    structured_payload: (r.structured_payload as Record<string, unknown>) ?? {},
    source: r.source === null || r.source === undefined ? null : String(r.source),
    trace_id: r.trace_id === null || r.trace_id === undefined ? null : String(r.trace_id),
    created_at: iso(r.created_at),
  };
}

// All or nothing. A detector recognizes a MARKER or a token, not the extent of a
// secret, so cutting the finding out of the text leaves the rest of the key
// behind — the private-key body outlived its own BEGIN line that way. The event
// itself is still recorded (sequence, type, actor, timestamp: the transcript
// keeps its shape and no caller has to retry), it just carries no text.
function withhold(
  content: string,
  payload: Record<string, unknown>,
): { content: string; payload: Record<string, unknown> } {
  const findings = findSecretsInPayload([content, payload]);
  if (!findings.length) return { content, payload };
  const kinds = findings.map((f) => f.kind).join(", ");
  // Both fields, on one finding: they are one statement, and a secret split
  // across them is invisible to a per-field decision anyway.
  return { content: `[withheld: ${kinds}]`, payload: { withheld: kinds } };
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// A thread has AT MOST ONE OWNER, ever. The first writer to name an agent claims
// it; a later claim by a different agent is refused, not silently dropped.
//
// This lives here because ensureThread is the only way a thread comes into
// existence, so no writer — tool, extractor, ingestion, or whatever is added
// next — can create or adopt one without passing it. Ownership is what tells a
// reader whose events a thread holds (tools.ts refuses a caller that names a
// thread together with an agent that does not own it), and an owner a second
// caller could overwrite would not be ownership at all.
export async function ensureThread(
  db: Db,
  threadId: string,
  agentId?: string,
): Promise<{ id: string; created: boolean }> {
  const res = await db.query(
    `INSERT INTO threads (id, agent_id) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [threadId, agentId ?? null],
  );
  if (res.rows.length) return { id: threadId, created: true };
  if (!agentId) return { id: threadId, created: false };
  // Conditional on agent_id IS NULL, so two concurrent claims cannot both win:
  // the loser reads the winner's row below and is refused.
  const claimed = await db.query(
    "UPDATE threads SET agent_id = $2 WHERE id = $1 AND agent_id IS NULL RETURNING id",
    [threadId, agentId],
  );
  if (claimed.rows.length) return { id: threadId, created: false };
  const row = await db.query("SELECT agent_id FROM threads WHERE id = $1", [threadId]);
  const owner = row.rows[0]?.agent_id;
  if (owner !== null && owner !== undefined && String(owner) !== agentId) {
    // Names no agent: which agent owns a thread is not something a caller that
    // does not own it gets to learn from an error message.
    throw new Error(`forbidden: thread ${threadId} belongs to another agent`);
  }
  return { id: threadId, created: false };
}

// A unique violation (SQLSTATE 23505). Message-matched as well as coded because
// the seam accepts any driver, and only the code is portable across all of them.
function isUniqueViolation(e: unknown): boolean {
  if ((e as { code?: unknown } | null)?.code === "23505") return true;
  return e instanceof Error && /duplicate key value|unique constraint/i.test(e.message);
}

export async function appendConversationEvent(
  db: Db,
  args: AppendEventArgs,
): Promise<AppendResult> {
  if (!args.threadId?.trim()) throw new Error("threadId is required");
  if (!IMPLIED_ACTOR[args.eventType]) throw new Error(`unknown event_type: ${args.eventType}`);
  // Only the user speaks for the user. `source` is set by the tool, not by the
  // tool's caller, so this is provenance an agent cannot forge — and without it
  // one `append_event {event_type:"user_message"}` plants a statement the next
  // extraction sweep auto-commits over the real value. Refused rather than
  // relabelled: an event that lies about who spoke has no honest form.
  if (args.source?.startsWith("tool:") && IMPLIED_ACTOR[args.eventType] === "user") {
    throw new Error(
      `forbidden: ${args.source} may not append a ${args.eventType} — only the user speaks for the user`,
    );
  }
  const { content, payload } = withhold(args.content ?? "", args.structuredPayload ?? {});
  // Hash what is STORED, so the row cannot be a fingerprint of a secret whose
  // text this table refused to keep.
  const hash = await sha256Hex(JSON.stringify([args.threadId, args.eventType, content, payload]));
  const id = crypto.randomUUID();

  const append = db.tx(async (q: Query) => {
    // The idempotency check lives inside the transaction that allocates the
    // sequence, so a replay that arrives after the first one committed never
    // reaches the insert. It is the fast path only: two CONCURRENT replays can
    // both pass it under READ COMMITTED, which the recovery below handles.
    if (args.idempotencyKey) {
      const dupe = await q(
        "SELECT * FROM conversation_events WHERE thread_id = $1 AND idempotency_key = $2",
        [args.threadId, args.idempotencyKey],
      );
      if (dupe.rows.length) return { event: rowToEvent(dupe.rows[0]), duplicate: true };
    }
    // Row lock, then bump: this is what makes ordering deterministic under
    // concurrent appends.
    const seqRow = await q(
      `UPDATE threads SET last_event_sequence = last_event_sequence + 1, updated_at = now()
       WHERE id = $1 RETURNING last_event_sequence`,
      [args.threadId],
    );
    if (!seqRow.rows.length) throw new Error(`not_found: thread ${args.threadId}`);
    const sequence = Number(seqRow.rows[0].last_event_sequence);

    const ins = await q(
      `INSERT INTO conversation_events
         (id, thread_id, sequence, event_type, actor_type, actor_id, content,
          structured_payload, source, trace_id, idempotency_key, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
       RETURNING *`,
      [
        id,
        args.threadId,
        sequence,
        args.eventType,
        IMPLIED_ACTOR[args.eventType],
        args.actorId ?? null,
        content,
        JSON.stringify(payload),
        args.source ?? null,
        args.traceId ?? null,
        args.idempotencyKey ?? null,
        hash,
      ],
    );
    return { event: rowToEvent(ins.rows[0]), duplicate: false };
  });
  if (!args.idempotencyKey) return append;

  // The in-transaction pre-check is the fast path, not the guarantee: under READ
  // COMMITTED it cannot see a concurrent replay's uncommitted row, so the loser
  // of that race reaches the partial unique index on (thread_id,
  // idempotency_key) instead. A replay's documented answer is {duplicate:true},
  // so read the winner back — its row is committed by the time we get here —
  // rather than surfacing a raw constraint violation to an at-least-once
  // pipeline. The failed transaction rolled back, so no sequence is burned.
  return append.catch(async (e) => {
    if (!isUniqueViolation(e)) throw e;
    const dupe = await db.query(
      "SELECT * FROM conversation_events WHERE thread_id = $1 AND idempotency_key = $2",
      [args.threadId, args.idempotencyKey],
    );
    if (!dupe.rows.length) throw e;
    return { event: rowToEvent(dupe.rows[0]), duplicate: true };
  });
}

export async function getConversationEvents(
  db: Db,
  args: { threadId: string; fromSequence?: number; throughSequence?: number; limit?: number },
): Promise<ConversationEvent[]> {
  const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 1000);
  const res = await db.query(
    `SELECT * FROM conversation_events
     WHERE thread_id = $1
       AND sequence > $2
       AND ($3::bigint IS NULL OR sequence <= $3)
     ORDER BY sequence LIMIT $4`,
    [args.threadId, args.fromSequence ?? 0, args.throughSequence ?? null, limit],
  );
  return res.rows.map(rowToEvent);
}

export async function getThread(
  db: Db,
  threadId: string,
): Promise<{
  id: string;
  agent_id: string | null;
  status: string;
  last_event_sequence: number;
  last_summary_sequence: number;
} | null> {
  const res = await db.query("SELECT * FROM threads WHERE id = $1", [threadId]);
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    agent_id: r.agent_id === null || r.agent_id === undefined ? null : String(r.agent_id),
    status: String(r.status),
    last_event_sequence: Number(r.last_event_sequence),
    last_summary_sequence: Number(r.last_summary_sequence),
  };
}
