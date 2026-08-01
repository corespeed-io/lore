// Layer 1: the immutable event log. This is the ground truth every other layer
// is derived from, which means two rules with no exceptions:
//
//   - Events are APPEND-ONLY. A correction is a new event, never an edit of an
//     old one, because a summary or a memory that cites event 7 must always be
//     able to read the event 7 it was built from.
//   - Ordering is deterministic. `sequence` is allocated under a row lock on
//     the thread, so two concurrent appends get 4 and 5 rather than both
//     believing they are 4.

import type { Db, Query } from "../db";

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
  actorType?: ActorType;
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

// Which actor an event type implies when the caller does not say. Keeping this
// derivable means a caller cannot label a user_message as coming from a tool.
const IMPLIED_ACTOR: Record<EventType, ActorType> = {
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

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
  return { id: threadId, created: res.rows.length > 0 };
}

export async function appendConversationEvent(
  db: Db,
  args: AppendEventArgs,
): Promise<AppendResult> {
  if (!args.threadId?.trim()) throw new Error("threadId is required");
  if (!IMPLIED_ACTOR[args.eventType]) throw new Error(`unknown event_type: ${args.eventType}`);
  const content = args.content ?? "";
  const payload = args.structuredPayload ?? {};
  const hash = await sha256Hex(JSON.stringify([args.threadId, args.eventType, content, payload]));
  const id = crypto.randomUUID();

  return db.tx(async (q: Query) => {
    // The idempotency check lives inside the transaction that allocates the
    // sequence: checking first and inserting after would let two replays of the
    // same key both pass the check.
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
        args.actorType ?? IMPLIED_ACTOR[args.eventType],
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
