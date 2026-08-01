// Layer 3: canonical durable memory and its lifecycle.
//
// The rule that shapes everything here: a committed memory is NEVER overwritten
// in place. A changed value means a new row, the old one closed out with a
// `valid_to`, and a revision recorded for both — so "what is it now?" and "what
// was it before?" are both answerable, and neither answer depends on a page or a
// summary still existing.
//
// Six operations, all deterministic:
//   ADD        a fact that has no active counterpart
//   NOOP       an equivalent active memory already exists
//   ENRICH     new non-conflicting detail on an existing logical memory
//   SUPERSEDE  the active value is out of date
//   CONFLICT   contradicts the active value, but neither source outranks the other
//   REVOKE     explicitly forget

import type { Db, Query } from "../db";
import { normalizeRef } from "../pipeline";
import { screenMemoryContent } from "./safety";

export type ScopeType = "thread" | "agent" | "vault";
export type MemoryType = "semantic" | "preference" | "episodic" | "procedural" | "working_state";
export type MemoryStatus =
  | "candidate"
  | "committed"
  | "superseded"
  | "revoked"
  | "rejected"
  | "expired"
  | "conflict";
export type Operation = "ADD" | "NOOP" | "ENRICH" | "SUPERSEDE" | "CONFLICT" | "REVOKE";

export interface MemoryItem {
  id: string;
  scope_type: ScopeType;
  scope_id: string | null;
  memory_type: MemoryType;
  memory_key: string | null;
  content: string;
  structured_value: Record<string, unknown>;
  status: MemoryStatus;
  confidence: number;
  salience: number;
  valid_from: string;
  valid_to: string | null;
  expires_at: string | null;
  supersedes_id: string | null;
  projection_page_id: number | null;
  projection_status: "pending" | "ok" | "failed" | "removed";
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WriteMemoryArgs {
  scopeType: ScopeType;
  scopeId?: string | null;
  memoryType: MemoryType;
  memoryKey?: string | null;
  content: string;
  structuredValue?: Record<string, unknown>;
  /** Events this memory is evidence from. Required to commit. */
  sourceEventIds?: string[];
  confidence?: number;
  salience?: number;
  expiresAt?: string | null;
  /** The user said it themselves, in this conversation. */
  explicit?: boolean;
  /** Came from an imported note, a web page, tool output… */
  externalContent?: boolean;
  createdBy?: string;
  reason?: string;
}

export interface WriteMemoryResult {
  operation: Operation | "REJECT";
  status: MemoryStatus | "rejected";
  memory: MemoryItem | null;
  /** The active memory this one replaced, when the operation was SUPERSEDE. */
  superseded?: MemoryItem | null;
  /** The active memory this one contradicts, when the operation was CONFLICT. */
  conflictsWith?: MemoryItem | null;
  reason?: string;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

export function rowToMemory(r: Record<string, unknown>): MemoryItem {
  return {
    id: String(r.id),
    scope_type: r.scope_type as ScopeType,
    scope_id: r.scope_id === null || r.scope_id === undefined ? null : String(r.scope_id),
    memory_type: r.memory_type as MemoryType,
    memory_key: r.memory_key === null || r.memory_key === undefined ? null : String(r.memory_key),
    content: String(r.content),
    structured_value: (r.structured_value as Record<string, unknown>) ?? {},
    status: r.status as MemoryStatus,
    confidence: Number(r.confidence),
    salience: Number(r.salience),
    valid_from: iso(r.valid_from),
    valid_to: r.valid_to ? iso(r.valid_to) : null,
    expires_at: r.expires_at ? iso(r.expires_at) : null,
    supersedes_id:
      r.supersedes_id === null || r.supersedes_id === undefined ? null : String(r.supersedes_id),
    projection_page_id:
      r.projection_page_id === null || r.projection_page_id === undefined
        ? null
        : Number(r.projection_page_id),
    projection_status: (r.projection_status as MemoryItem["projection_status"]) ?? "pending",
    created_by: String(r.created_by ?? "system"),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The identity of a proposal: same scope, type, key, normalized content and
// source range means the same memory. This is what makes re-running extraction
// over a conversation range a NOOP instead of a duplicate.
export function memoryFingerprint(args: {
  scopeType: string;
  scopeId?: string | null;
  memoryType: string;
  memoryKey?: string | null;
  content: string;
  sourceEventIds?: string[];
}): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      args.scopeType,
      args.scopeId ?? "",
      args.memoryType,
      normalizeRef(args.memoryKey ?? ""),
      normalizeRef(args.content),
      [...(args.sourceEventIds ?? [])].sort(),
    ]),
  );
}

async function revise(
  q: Query,
  args: {
    memoryId: string;
    operation: string;
    previousStatus?: string | null;
    newStatus?: string | null;
    previousContent?: string | null;
    newContent?: string | null;
    actor?: string;
    reason?: string | null;
  },
): Promise<void> {
  await q(
    `INSERT INTO memory_revisions
       (id, memory_id, operation, previous_status, new_status, previous_content, new_content, actor, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      crypto.randomUUID(),
      args.memoryId,
      args.operation,
      args.previousStatus ?? null,
      args.newStatus ?? null,
      args.previousContent ?? null,
      args.newContent ?? null,
      args.actor ?? "system",
      args.reason ?? null,
    ],
  );
}

// The active memory for a logical key, if any. "Active" excludes everything the
// lifecycle has retired, which is what makes a superseded value vanish from
// current retrieval the moment it is replaced.
export async function getActiveByKey(
  db: Db,
  args: {
    scopeType: ScopeType;
    scopeId?: string | null;
    memoryType: MemoryType;
    memoryKey: string;
  },
): Promise<MemoryItem | null> {
  const res = await db.query(
    `SELECT * FROM memory_items
     WHERE scope_type = $1 AND coalesce(scope_id, '') = coalesce($2, '')
       AND memory_type = $3 AND memory_key = $4 AND status = 'committed'`,
    [args.scopeType, args.scopeId ?? null, args.memoryType, args.memoryKey],
  );
  return res.rows[0] ? rowToMemory(res.rows[0]) : null;
}

export async function getMemory(db: Db, id: string): Promise<MemoryItem | null> {
  const res = await db.query("SELECT * FROM memory_items WHERE id = $1", [id]);
  return res.rows[0] ? rowToMemory(res.rows[0]) : null;
}

function normalizedEqual(a: string, b: string): boolean {
  return normalizeRef(a) === normalizeRef(b);
}

// The one entry point for creating or changing durable memory. Decides which
// operation applies, then performs it atomically.
export async function writeMemory(db: Db, args: WriteMemoryArgs): Promise<WriteMemoryResult> {
  if (!args.content?.trim()) throw new Error("content is required");
  if (args.scopeType !== "vault" && !args.scopeId) {
    // Never widen scope because an id is missing: a thread memory with no thread
    // is not a vault memory.
    throw new Error(`scopeId is required for scope_type ${args.scopeType}`);
  }

  const screen = screenMemoryContent({
    content: args.content,
    memoryType: args.memoryType,
    explicit: Boolean(args.explicit),
    externalContent: args.externalContent,
  });
  if (!screen.allow) {
    return { operation: "REJECT", status: "rejected", memory: null, reason: screen.reason };
  }
  const sources = args.sourceEventIds ?? [];
  // Provenance is not optional for a committed memory. Without a source event
  // it can only ever be a candidate.
  const commitable = !screen.downgradeToCandidate && sources.length > 0;
  const targetStatus: MemoryStatus = commitable ? "committed" : "candidate";

  const fingerprint = await memoryFingerprint(args);
  const existingFp = await db.query("SELECT * FROM memory_items WHERE fingerprint = $1", [
    fingerprint,
  ]);
  if (existingFp.rows.length) {
    // Same scope, key, content and evidence: this exact proposal has been seen.
    return {
      operation: "NOOP",
      status: existingFp.rows[0].status as MemoryStatus,
      memory: rowToMemory(existingFp.rows[0]),
      reason: "identical memory already recorded",
    };
  }

  const active = args.memoryKey
    ? await getActiveByKey(db, {
        scopeType: args.scopeType,
        scopeId: args.scopeId,
        memoryType: args.memoryType,
        memoryKey: args.memoryKey,
      })
    : null;

  // An active memory saying the same thing in different words is still the same
  // memory.
  if (active && normalizedEqual(active.content, args.content)) {
    return {
      operation: "NOOP",
      status: active.status,
      memory: active,
      reason: "active memory already says this",
    };
  }

  const id = crypto.randomUUID();
  const confidence = args.confidence ?? (args.explicit ? 0.9 : 0.5);
  const salience = args.salience ?? 0.5;

  return db.tx(async (q) => {
    const insert = async (status: MemoryStatus, supersedesId: string | null) => {
      const res = await q(
        `INSERT INTO memory_items
           (id, scope_type, scope_id, memory_type, memory_key, content, structured_value,
            status, confidence, salience, expires_at, supersedes_id, fingerprint, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          id,
          args.scopeType,
          args.scopeId ?? null,
          args.memoryType,
          args.memoryKey ?? null,
          args.content,
          JSON.stringify(args.structuredValue ?? {}),
          status,
          confidence,
          salience,
          args.expiresAt ?? null,
          supersedesId,
          fingerprint,
          args.createdBy ?? "system",
        ],
      );
      for (const eventId of sources) {
        await q(
          `INSERT INTO memory_sources (memory_id, event_id, evidence_type)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [id, eventId, args.explicit ? "explicit_statement" : "inferred"],
        );
      }
      return rowToMemory(res.rows[0]);
    };

    // No active counterpart: a plain ADD (committed or candidate).
    if (!active) {
      const memory = await insert(targetStatus, null);
      await revise(q, {
        memoryId: id,
        operation: "ADD",
        newStatus: targetStatus,
        newContent: args.content,
        actor: args.createdBy ?? "system",
        reason: args.reason ?? screen.reason ?? null,
      });
      return { operation: "ADD", status: targetStatus, memory };
    }

    // There IS an active value and this one differs. Whether we may replace it
    // depends on whether this source outranks it.
    if (!commitable) {
      // Not authorized to overwrite: record the disagreement instead of picking
      // a winner. A human or a policy resolves it later.
      const memory = await insert("conflict", null);
      await revise(q, {
        memoryId: id,
        operation: "CONFLICT",
        newStatus: "conflict",
        previousContent: active.content,
        newContent: args.content,
        actor: args.createdBy ?? "system",
        reason: args.reason ?? screen.reason ?? "source authority insufficient to supersede",
      });
      return {
        operation: "CONFLICT",
        status: "conflict",
        memory,
        conflictsWith: active,
        reason: screen.reason ?? "conflicting value from a non-authoritative source",
      };
    }

    // SUPERSEDE: create the replacement, commit it, close the old one out.
    const memory = await insert("committed", active.id);
    await q(
      `UPDATE memory_items
       SET status = 'superseded', valid_to = now(), updated_at = now()
       WHERE id = $1`,
      [active.id],
    );
    await revise(q, {
      memoryId: active.id,
      operation: "SUPERSEDE",
      previousStatus: active.status,
      newStatus: "superseded",
      previousContent: active.content,
      newContent: args.content,
      actor: args.createdBy ?? "system",
      reason: args.reason ?? `superseded by ${id}`,
    });
    await revise(q, {
      memoryId: id,
      operation: "ADD",
      newStatus: "committed",
      newContent: args.content,
      actor: args.createdBy ?? "system",
      reason: args.reason ?? `supersedes ${active.id}`,
    });
    return { operation: "SUPERSEDE", status: "committed", memory, superseded: active };
  });
}

// Non-conflicting extra detail on an existing logical memory. Kept separate from
// SUPERSEDE because "also true" and "no longer true" are different claims.
export async function enrichMemory(
  db: Db,
  args: {
    memoryId: string;
    structuredValue: Record<string, unknown>;
    actor?: string;
    reason?: string;
  },
): Promise<MemoryItem | null> {
  return db.tx(async (q) => {
    const cur = await q("SELECT * FROM memory_items WHERE id = $1", [args.memoryId]);
    if (!cur.rows.length) return null;
    const before = rowToMemory(cur.rows[0]);
    const merged = { ...before.structured_value, ...args.structuredValue };
    const res = await q(
      "UPDATE memory_items SET structured_value = $1::jsonb, updated_at = now() WHERE id = $2 RETURNING *",
      [JSON.stringify(merged), args.memoryId],
    );
    await revise(q, {
      memoryId: args.memoryId,
      operation: "ENRICH",
      previousStatus: before.status,
      newStatus: before.status,
      actor: args.actor,
      reason: args.reason ?? "non-conflicting detail added",
    });
    return rowToMemory(res.rows[0]);
  });
}

// Explicitly forget. The row stays (history is the point of revisions) but it
// leaves active retrieval immediately, and its projection is marked for cleanup.
export async function revokeMemory(
  db: Db,
  args: { memoryId: string; actor?: string; reason?: string },
): Promise<MemoryItem | null> {
  return db.tx(async (q) => {
    const cur = await q("SELECT * FROM memory_items WHERE id = $1", [args.memoryId]);
    if (!cur.rows.length) return null;
    const before = rowToMemory(cur.rows[0]);
    const res = await q(
      `UPDATE memory_items
       SET status = 'revoked', valid_to = coalesce(valid_to, now()), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [args.memoryId],
    );
    await revise(q, {
      memoryId: args.memoryId,
      operation: "REVOKE",
      previousStatus: before.status,
      newStatus: "revoked",
      previousContent: before.content,
      actor: args.actor,
      reason: args.reason ?? "revoked",
    });
    return rowToMemory(res.rows[0]);
  });
}

// Promote a candidate once a human or a policy has approved it. Provenance is
// still required, so a candidate with no source cannot be committed.
export async function commitCandidate(
  db: Db,
  args: { memoryId: string; actor?: string; reason?: string },
): Promise<WriteMemoryResult> {
  const cur = await getMemory(db, args.memoryId);
  if (!cur) return { operation: "REJECT", status: "rejected", memory: null, reason: "not_found" };
  if (cur.status !== "candidate" && cur.status !== "conflict") {
    return { operation: "NOOP", status: cur.status, memory: cur, reason: "not a candidate" };
  }
  const src = await db.query("SELECT count(*)::int AS n FROM memory_sources WHERE memory_id = $1", [
    args.memoryId,
  ]);
  if (Number(src.rows[0].n) === 0) {
    return {
      operation: "REJECT",
      status: "rejected",
      memory: cur,
      reason: "cannot commit a memory with no source event",
    };
  }
  return db.tx(async (q) => {
    // Committing a keyed candidate supersedes whatever is active for that key,
    // or the partial unique index would reject the second committed row.
    let superseded: MemoryItem | null = null;
    if (cur.memory_key) {
      const activeRes = await q(
        `SELECT * FROM memory_items
         WHERE scope_type = $1 AND coalesce(scope_id,'') = coalesce($2,'')
           AND memory_type = $3 AND memory_key = $4 AND status = 'committed' AND id <> $5`,
        [cur.scope_type, cur.scope_id, cur.memory_type, cur.memory_key, cur.id],
      );
      if (activeRes.rows.length) {
        superseded = rowToMemory(activeRes.rows[0]);
        await q(
          "UPDATE memory_items SET status = 'superseded', valid_to = now(), updated_at = now() WHERE id = $1",
          [superseded.id],
        );
        await revise(q, {
          memoryId: superseded.id,
          operation: "SUPERSEDE",
          previousStatus: superseded.status,
          newStatus: "superseded",
          previousContent: superseded.content,
          newContent: cur.content,
          actor: args.actor,
          reason: `superseded by committed candidate ${cur.id}`,
        });
      }
    }
    const res = await q(
      `UPDATE memory_items
       SET status = 'committed', supersedes_id = coalesce(supersedes_id, $2),
           projection_status = 'pending', updated_at = now()
       WHERE id = $1 RETURNING *`,
      [args.memoryId, superseded?.id ?? null],
    );
    await revise(q, {
      memoryId: args.memoryId,
      operation: "COMMIT",
      previousStatus: cur.status,
      newStatus: "committed",
      actor: args.actor,
      reason: args.reason ?? "approved",
    });
    return {
      operation: "ADD" as Operation,
      status: "committed" as MemoryStatus,
      memory: rowToMemory(res.rows[0]),
      superseded,
    };
  });
}

// Time-based retirement, run by consolidation. Separate from revoke because
// "the user said forget it" and "it aged out" are different histories.
export async function expireMemories(db: Db, limit = 200): Promise<{ expired: number }> {
  const due = await db.query(
    `SELECT id, status, content FROM memory_items
     WHERE status = 'committed' AND expires_at IS NOT NULL AND expires_at <= now()
     ORDER BY expires_at LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
  let expired = 0;
  for (const row of due.rows) {
    await db.tx(async (q) => {
      await q(
        `UPDATE memory_items SET status = 'expired', valid_to = coalesce(valid_to, now()),
           updated_at = now() WHERE id = $1`,
        [row.id],
      );
      await revise(q, {
        memoryId: String(row.id),
        operation: "EXPIRE",
        previousStatus: String(row.status),
        newStatus: "expired",
        previousContent: String(row.content),
        reason: "expires_at reached",
      });
    });
    expired++;
  }
  return { expired };
}

export interface MemoryInspection {
  memory: MemoryItem;
  sources: { event_id: string; evidence_type: string; sequence: number | null }[];
  revisions: {
    operation: string;
    previous_status: string | null;
    new_status: string | null;
    actor: string;
    reason: string | null;
    created_at: string;
  }[];
}

export async function inspectMemory(db: Db, id: string): Promise<MemoryInspection | null> {
  const memory = await getMemory(db, id);
  if (!memory) return null;
  const sources = await db.query(
    `SELECT s.event_id, s.evidence_type, e.sequence
     FROM memory_sources s LEFT JOIN conversation_events e ON e.id = s.event_id
     WHERE s.memory_id = $1 ORDER BY e.sequence NULLS LAST`,
    [id],
  );
  const revisions = await db.query(
    `SELECT operation, previous_status, new_status, actor, reason, created_at
     FROM memory_revisions WHERE memory_id = $1 ORDER BY created_at, id`,
    [id],
  );
  return {
    memory,
    sources: sources.rows.map((r) => ({
      event_id: String(r.event_id),
      evidence_type: String(r.evidence_type),
      sequence: r.sequence === null || r.sequence === undefined ? null : Number(r.sequence),
    })),
    revisions: revisions.rows.map((r) => ({
      operation: String(r.operation),
      previous_status: r.previous_status ? String(r.previous_status) : null,
      new_status: r.new_status ? String(r.new_status) : null,
      actor: String(r.actor),
      reason: r.reason ? String(r.reason) : null,
      created_at: iso(r.created_at),
    })),
  };
}
