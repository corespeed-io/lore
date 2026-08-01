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
//
// The second rule, and the reason `amendMemory` exists: AUTHORITY BELONGS TO THE
// ROW, NOT TO THE VERB. Whether a change is allowed is decided once, in one
// function every change to an existing row goes through — not re-decided by each
// operation. Guarding the ADD path alone is exactly how a keyed `remember` was
// made safe while `forget` next to it still retired the same fact for free: two
// ordinary tool calls (forget, then remember) replaced a value the user had
// stated. A verb added tomorrow inherits the rule because it cannot change a row
// without passing through the same door.

import type { Db, Query } from "../db";
import { normalizeRef } from "../pipeline";
import { findSecretsInPayload, screenMemoryContent } from "./safety";

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

// --- Authority ---------------------------------------------------------------
//
// Who a change speaks for is DERIVED, never passed. There is no `authority`
// argument, no `explicit: true` to set, no actor string an LLM can choose —
// because every one of those is a claim, and a claim is what the agent surface
// gets to make. Both inputs below are columns the agent surface cannot write.

// An event that carries the USER's own words. `actor_type` is derived from the
// event type inside events.ts (never supplied by a caller) and `source` is
// stamped by the WRITER, not by the writer's caller — so a tool cannot append
// one of these at all (events.ts refuses `tool:`-sourced user-implied events).
// Keyed on actor_type rather than a list of event types on purpose: a
// user-implied type added tomorrow is covered the day it is added.
// Unstamped `source` counts as the user's own transport, which is the contract
// extract.ts's speaksForUser reads the same way — the two must agree, or a
// memory extraction treats as the user's would be unprotected here.
const USER_EVENT_SQL = "e.actor_type = 'user' AND (e.source IS NULL OR e.source LIKE 'user:%')";

/** Was this memory's evidence the user's own words? */
export async function statedByUser(q: Query, memoryId: string): Promise<boolean> {
  const res = await q(
    `SELECT 1 FROM memory_sources s JOIN conversation_events e ON e.id = s.event_id
     WHERE s.memory_id = $1 AND ${USER_EVENT_SQL} LIMIT 1`,
    [memoryId],
  );
  return res.rows.length > 0;
}

/** Does this change cite the user's own words as its evidence? */
async function citesUser(q: Query, eventIds: readonly string[]): Promise<boolean> {
  if (eventIds.length === 0) return false;
  const res = await q(
    `SELECT 1 FROM conversation_events e WHERE e.id = ANY($1::text[]) AND ${USER_EVENT_SQL} LIMIT 1`,
    [[...eventIds]],
  );
  return res.rows.length > 0;
}

// Is this change being made through the AGENT surface? tools.ts stamps
// `tool:<name>` on every actor and every createdBy it writes, and never takes
// that string from its caller — the same provenance rule, for the same reason,
// as `source` on an event.
//
// AN ALLOW-LIST, DEFAULT DENY. This was written as a deny-list on one exact byte
// prefix — `!name || name.startsWith("tool:")` — while the comment above it
// promised "unknown authority is the WEAKEST authority". Those are opposite
// rules, and the code was the weaker one: only an empty or missing actor failed
// closed, and every OTHER unrecognised string was read as "code in this repo"
// and handed full authority to retire a memory the user stated. An adversarial
// pass drove twelve of them through — `Tool:forget`, `TOOL:FORGET`,
// `tools:forget`, `tool_forget`, `tool.forget`, `tool :forget`, the fullwidth
// `ｔｏｏｌ:forget`, a zero-width space before the colon, `mcp/tool:forget`,
// `agent:rogue`, `handler:forget_v2`, and the bare word `tool`. None is reachable
// from a door today, because no caller-controlled string becomes an actor; that
// makes it a latent defect rather than a live one, and exactly the kind that the
// next handler to name itself `agent:consolidator` collects.
//
// So the trusted vocabulary is ENUMERATED, the way READ_ONLY_TOOLS and
// ADMIN_ENDPOINTS are enumerated elsewhere in this repo, and everything outside
// it is the agent surface. The design decision this preserves is the one the
// old comment described and tests/memory-authority.test.ts pins: a NAMED
// in-process caller — a migration, the extraction pass, an admin console — is
// code in this repo rather than text from a model, and may amend. What changes
// is that it must be named HERE to count, so the twelve strings above fail
// closed instead of being promoted by a prefix test that never saw them.
//
// Matched exactly, or as `<authority>:<detail>` so a caller can say which
// migration it is. Case-sensitive and untrimmed beyond whitespace: `Admin` is
// not `admin`, because a classifier that folds case is a second reader of the
// name and this whole finding is what that costs.
const IN_REPO_AUTHORITIES: readonly string[] = ["system", "extractor", "admin"];

// How in-repo code NAMES itself, so the vocabulary cannot drift away from the
// registry above. episodes.ts spelled its actors `episode-recorder` and
// `procedure-promoter` freehand: both are in-repo callers, both were trusted by
// the old prefix deny-list, and neither is in the registry — so tightening the
// classifier silently turned a legitimate `promoteProcedure` SUPERSEDE into a
// CONFLICT, leaving a stale procedure active with no error raised. That is the
// mirror failure, and it is why the registry cannot be a list someone remembers
// to join: a module asks for its name here instead of inventing one.
//
// `user` is deliberately NOT a registry entry. Nothing in this repo stamps it,
// and `user:<transport>` is the spelling USER_EVENT_SQL reserves for the user's
// own event SOURCE — so a future writer naming itself `user:slack` by analogy
// would collect unconditional amend authority without citing any event. The
// user's authority comes from cited events, which is a thing that must exist,
// never from a name, which is a thing anyone can type.
export function inRepoActor(name: string): string {
  return `system:${name}`;
}

function fromAgentSurface(actor?: string | null): boolean {
  const name = actor?.trim();
  if (!name) return true;
  return !IN_REPO_AUTHORITIES.some((a) => name === a || name.startsWith(`${a}:`));
}

// THE RULE, written once. A change may not retire or rewrite a memory the user
// stated unless the change itself carries the user's words. There is no name a
// caller can present that substitutes for that evidence.
async function mayAmend(
  q: Query,
  memoryId: string,
  by: { actor?: string | null; sourceEventIds?: readonly string[] },
): Promise<boolean> {
  if (!fromAgentSurface(by.actor)) return true;
  if (await citesUser(q, by.sourceEventIds ?? [])) return true;
  return !(await statedByUser(q, memoryId));
}

// A row moving to 'expired' because its OWN expires_at has passed is authorized
// by the row, not by whoever runs the sweep: expires_at is written once, by the
// INSERT below, and no statement anywhere updates it afterwards. Read from the
// locked row rather than believed from the caller, so a sweep cannot expire
// anything early and cannot expire anything that never asked to expire.
function isSelfExpiry(before: MemoryItem, status: MemoryStatus | undefined): boolean {
  return (
    status === "expired" &&
    before.expires_at !== null &&
    Date.parse(before.expires_at) <= Date.now()
  );
}

export interface Amendment {
  memoryId: string;
  /** memory_revisions.operation for this change. */
  operation: string;
  status?: MemoryStatus;
  /** Already merged by the caller; written whole. */
  structuredValue?: Record<string, unknown>;
  supersedesId?: string | null;
  /** Mark the projection for a rebuild (a newly committed memory needs a page). */
  resetProjection?: boolean;
  /** Evidence for the change ITSELF — this is what can carry user authority. */
  sourceEventIds?: readonly string[];
  actor?: string;
  reason?: string;
  /** Recorded on the revision only. */
  newContent?: string | null;
}

// THE CHOKEPOINT. Every change to an existing memory row's authored state —
// status, structured_value, valid_to, supersedes_id — happens here.
// SUPERSEDE, REVOKE, EXPIRE, COMMIT and ENRICH are five callers of one function,
// not five places that each remember to check; a sixth verb cannot change a row
// without becoming a sixth caller. Nothing else in this file writes those
// columns on an existing row.
//
// Refuses by THROWING: a revocation that silently did nothing while reporting
// {revoked:1} is the failure this exists to prevent, so the caller is told.
export async function amendMemory(
  q: Query,
  a: Amendment,
): Promise<{ before: MemoryItem; after: MemoryItem } | null> {
  // Locked: the authority decision and the write must see the same row, or a
  // concurrent amendment is authorized against a state that no longer exists.
  const cur = await q("SELECT * FROM memory_items WHERE id = $1 FOR UPDATE", [a.memoryId]);
  if (!cur.rows.length) return null;
  const before = rowToMemory(cur.rows[0]);
  // RETIREMENT IS TERMINAL, decided from the LOCKED row. Locking it and then not
  // reading its status was the gap: `revoked -> superseded` succeeded, and those
  // two are not interchangeable — AS_OF_SQL includes 'superseded' and deliberately
  // excludes 'revoked', so flipping a revoked row put its content back within
  // reach of a historical read. Every caller picks its target as committed
  // OUTSIDE this lock (writeMemory's twin lookup, commitCandidate's SELECT), so a
  // forget racing an extraction-driven supersede lands exactly here. The check has
  // to be inside the lock, on `before`, or it is a check on a row that has moved.
  //
  // A repeat of the SAME status is a no-op rather than an error, so a retried
  // forget still answers instead of throwing on its own success.
  if (before.status !== "committed" && before.status !== "candidate") {
    if (a.status === undefined || a.status === before.status) {
      return { before, after: before };
    }
    throw new Error(
      `refused: memory ${a.memoryId} is ${before.status} — a retired memory's ` +
        `authored state is history and cannot be ${a.operation.toLowerCase()}d`,
    );
  }

  if (
    !isSelfExpiry(before, a.status) &&
    !(await mayAmend(q, a.memoryId, { actor: a.actor, sourceEventIds: a.sourceEventIds }))
  ) {
    throw new Error(
      `refused: memory ${a.memoryId} was stated by the user — an agent may not ` +
        `${a.operation.toLowerCase()} it. Only the user can change what the user said.`,
    );
  }

  // Anything that is not 'committed' has left active retrieval, so its validity
  // window closes. coalesce, never a bare now(): a window that was already
  // closed keeps the timestamp it was closed at, or an as_of read moves.
  const retires = a.status !== undefined && a.status !== "committed" && a.status !== "candidate";
  const res = await q(
    `UPDATE memory_items
       SET status = coalesce($2::text, status),
           structured_value = coalesce($3::jsonb, structured_value),
           supersedes_id = coalesce(supersedes_id, $4::text),
           projection_status = CASE WHEN $5::boolean THEN 'pending' ELSE projection_status END,
           valid_to = CASE WHEN $6::boolean THEN coalesce(valid_to, now()) ELSE valid_to END,
           updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      a.memoryId,
      a.status ?? null,
      a.structuredValue ? JSON.stringify(a.structuredValue) : null,
      a.supersedesId ?? null,
      Boolean(a.resetProjection),
      retires,
    ],
  );
  await revise(q, {
    memoryId: a.memoryId,
    operation: a.operation,
    previousStatus: before.status,
    newStatus: a.status ?? before.status,
    previousContent: before.content,
    newContent: a.newContent ?? null,
    actor: a.actor,
    reason: a.reason ?? null,
  });
  return { before, after: rowToMemory(res.rows[0]) };
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
    structuredValue: args.structuredValue,
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

  // A user statement must never leave the user with LESS authority than an
  // agent's copy of the same sentence. The attack this closes runs the other way
  // round from the obvious one: the agent stores the sentence FIRST, the user
  // says it second, and consolidation's duplicate sweep keeps the OLDEST row —
  // the agent's — so the only surviving copy is one the agent may then forget.
  // Rather than create the duplicate and argue about which survives, the user's
  // evidence is attached to the row that already says it: one row, and it is now
  // the user's. Deliberately the SAME comparison consolidate.ts groups on
  // (scope, type, key, lower(btrim(content))), so what that sweep would call a
  // duplicate is exactly what this refuses to leave lying around.
  //
  // One-directional and not guarded by amendMemory: this only ever RAISES a
  // row's authority, it only fires when the user's own words trigger it, and it
  // changes nothing a reader can see.
  const twin = await db.query(
    `SELECT id FROM memory_items
      WHERE status = 'committed'
        AND scope_type = $1 AND coalesce(scope_id, '') = coalesce($2, '')
        AND memory_type = $3 AND coalesce(memory_key, '') = coalesce($4, '')
        AND lower(btrim(content)) = lower(btrim($5::text))
      ORDER BY created_at LIMIT 1`,
    [args.scopeType, args.scopeId ?? null, args.memoryType, args.memoryKey ?? null, args.content],
  );
  const twinId = twin.rows[0] ? String(twin.rows[0].id) : null;
  if (twinId && (await citesUser(db.query, sources)) && !(await statedByUser(db.query, twinId))) {
    return db.tx(async (q) => {
      for (const eventId of sources) {
        await q(
          `INSERT INTO memory_sources (memory_id, event_id, evidence_type)
           VALUES ($1, $2, 'explicit_statement') ON CONFLICT DO NOTHING`,
          [twinId, eventId],
        );
      }
      const reason = "the user stated what this memory already says; their evidence is now on it";
      await revise(q, {
        memoryId: twinId,
        operation: "NOOP",
        actor: args.createdBy ?? "system",
        reason,
      });
      const row = await q("SELECT * FROM memory_items WHERE id = $1", [twinId]);
      const memory = rowToMemory(row.rows[0]);
      return { operation: "NOOP", status: memory.status, memory, reason };
    });
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

    // There IS an active value and this one differs. Two separate questions:
    // may this source commit at all (provenance + screening), and may it retire
    // THAT row (authority, which belongs to the row). Asked here so the honest
    // answer is a recorded CONFLICT; amendMemory below is what enforces it.
    const mayReplace =
      commitable &&
      (await mayAmend(q, active.id, { actor: args.createdBy, sourceEventIds: sources }));
    if (!mayReplace) {
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

    // SUPERSEDE. Order matters: the partial unique index allows ONE committed row
    // per (scope, type, key), so the old row must be retired BEFORE the
    // replacement is inserted. Both happen in this transaction, so a failed
    // insert rolls the retirement back rather than leaving the key with no
    // active value.
    await amendMemory(q, {
      memoryId: active.id,
      operation: "SUPERSEDE",
      status: "superseded",
      sourceEventIds: sources,
      actor: args.createdBy ?? "system",
      reason: args.reason ?? `superseded by ${id}`,
      newContent: args.content,
    });
    const memory = await insert("committed", active.id);
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
    /** Evidence for the enrichment itself; the only thing that carries user authority. */
    sourceEventIds?: readonly string[];
  },
): Promise<MemoryItem | null> {
  return db.tx(async (q) => {
    const cur = await q("SELECT * FROM memory_items WHERE id = $1 FOR UPDATE", [args.memoryId]);
    if (!cur.rows.length) return null;
    const before = rowToMemory(cur.rows[0]);
    // Enrich is a second door into structured_value, so it passes the same
    // secret scan writeMemory does. Only the detector, not the whole screen:
    // enrich adds detail to an already-screened memory, it does not create one,
    // so there is no status to downgrade — but a credential is still refused.
    //
    // findSecretsInPayload over the OBJECT, not findSecrets over a
    // JSON.stringify of it. That was a second reader of the credential rule, and
    // safety.ts's own header says why it could not work: escaping turns
    // `api_key: hunter2swordfish` into `"api_key":"hunter2swordfish"`, putting a
    // quote between the label and the colon, so labelled_credential — the
    // adjacency pattern this whole round is about — could never fire here. It
    // passed its test only because an OpenAI key has a shape of its own and needs
    // no label. AGENTS.md meanwhile calls this "the second door into that column"
    // and says it screens too; now it screens the same way.
    const secrets = findSecretsInPayload(args.structuredValue);
    if (secrets.length) {
      throw new Error(
        `contains ${secrets.map((f) => f.kind).join(", ")} — credentials are never stored as memory`,
      );
    }
    // Through the chokepoint like every other change: ENRICH rewrites what a
    // memory says (structured_value is on the row, rendered into the projection
    // and read back by inspect_memory), so "adds detail" is not a reason to skip
    // the authority the row carries.
    const merged = { ...before.structured_value, ...args.structuredValue };
    const done = await amendMemory(q, {
      memoryId: args.memoryId,
      operation: "ENRICH",
      structuredValue: merged,
      sourceEventIds: args.sourceEventIds,
      actor: args.actor,
      reason: args.reason ?? "non-conflicting detail added",
    });
    return done?.after ?? null;
  });
}

// Explicitly forget. The row stays (history is the point of revisions) but it
// leaves active retrieval immediately, and its projection is marked for cleanup.
export async function revokeMemory(
  db: Db,
  args: {
    memoryId: string;
    actor?: string;
    reason?: string;
    /** Evidence for the revocation itself. A user asking to forget something is
     *  a user_message; citing it is how a revocation carries the user's
     *  authority. Citing nothing is an agent revoking, whatever it calls itself. */
    sourceEventIds?: readonly string[];
  },
): Promise<MemoryItem | null> {
  return db.tx(async (q) => {
    const done = await amendMemory(q, {
      memoryId: args.memoryId,
      operation: "REVOKE",
      status: "revoked",
      sourceEventIds: args.sourceEventIds,
      actor: args.actor,
      reason: args.reason ?? "revoked",
    });
    return done?.after ?? null;
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
  const src = await db.query("SELECT event_id FROM memory_sources WHERE memory_id = $1", [
    args.memoryId,
  ]);
  if (src.rows.length === 0) {
    return {
      operation: "REJECT",
      status: "rejected",
      memory: cur,
      reason: "cannot commit a memory with no source event",
    };
  }
  // Deliberately NOT passed to amendMemory below: the authority for a change is
  // the evidence THE CHANGE cites, never evidence the target already carried.
  // Inheriting it would mean an agent gains the user's authority by pointing at
  // a candidate the user's words produced — and promoting such a candidate to
  // committed policy is precisely what its demotion existed to prevent.
  // The APPROVER is the authority here, and the approver is the actor.
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
        await amendMemory(q, {
          memoryId: superseded.id,
          operation: "SUPERSEDE",
          status: "superseded",
          actor: args.actor,
          reason: `superseded by committed candidate ${cur.id}`,
          newContent: cur.content,
        });
      }
    }
    const done = await amendMemory(q, {
      memoryId: args.memoryId,
      operation: "COMMIT",
      status: "committed",
      supersedesId: superseded?.id ?? null,
      resetProjection: true,
      actor: args.actor,
      reason: args.reason ?? "approved",
    });
    if (!done) {
      return { operation: "REJECT", status: "rejected", memory: null, reason: "not_found" };
    }
    return {
      operation: "ADD" as Operation,
      status: "committed" as MemoryStatus,
      memory: done.after,
      superseded,
    };
  });
}

// Time-based retirement, run by consolidation. Separate from revoke because
// "the user said forget it" and "it aged out" are different histories.
export async function expireMemories(db: Db, limit = 200): Promise<{ expired: number }> {
  const due = await db.query(
    `SELECT id FROM memory_items
     WHERE status = 'committed' AND expires_at IS NOT NULL AND expires_at <= now()
     ORDER BY expires_at LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
  let expired = 0;
  for (const row of due.rows) {
    // No actor and no cited event: the sweep has no authority of its own. It
    // gets through the chokepoint only because the ROW authorized this, by
    // carrying an expires_at that has passed (isSelfExpiry re-checks it against
    // the locked row). Counted only when a row actually moved.
    const done = await db.tx(async (q) =>
      Boolean(
        await amendMemory(q, {
          memoryId: String(row.id),
          operation: "EXPIRE",
          status: "expired",
          reason: "expires_at reached",
        }),
      ),
    );
    if (done) expired++;
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
