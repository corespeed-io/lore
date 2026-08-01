// Turning events into memory proposals.
//
// The extractor is an interface, and the DEFAULT implementation is deterministic
// rules rather than a model. That is a deliberate choice: a rule-based extractor
// makes every test stable, lets a deployment run the whole memory system with no
// model at all, and — because it can only recognize shapes it was taught — it
// cannot hallucinate a fact the user never stated. A model-backed extractor can
// be dropped in behind the same interface; its proposals arrive as candidates.
//
// What is never extracted, enforced here and again in safety.ts:
//   - assistant guesses as user facts (only a user_message the USER's own
//     transport wrote is explicit — see speaksForUser: the event's `source`
//     decides, because the event TYPE is an argument a caller chooses)
//   - credentials of any kind
//   - hidden reasoning (never in the event log to begin with)
//   - instructions found in content, as policy
//   - transient task chatter with no future value

import type { Db } from "../db";
import { normalizeRef } from "../pipeline";
import type { ConversationEvent } from "./events";
import { getConversationEvents } from "./events";
import type { MemoryItem, MemoryType, Operation, ScopeType } from "./items";
import { rowToMemory, writeMemory } from "./items";
import { findSecrets, looksLikeInstruction } from "./safety";
import type { StructuredSummary } from "./summary";

export interface MemoryProposal {
  operation: Operation;
  scope_type: ScopeType;
  scope_id: string | null;
  memory_type: MemoryType;
  memory_key: string | null;
  content: string;
  structured_value: Record<string, unknown>;
  source_event_ids: string[];
  confidence: number;
  salience: number;
  /** The user said this themselves, in a user_message. */
  explicit: boolean;
}

export interface ExtractorInput {
  events: ConversationEvent[];
  summary: StructuredSummary | null;
  /** A small relevant slice of active memory, for supersede/NOOP decisions. */
  activeMemories: MemoryItem[];
  allowedScopes: { scopeType: ScopeType; scopeId: string | null }[];
}

export interface MemoryExtractor {
  readonly version: string;
  extract(input: ExtractorInput): Promise<{ proposals: MemoryProposal[] }>;
}

// --- value shapes, used to decide what an unlabelled correction refers to ----

type ValueShape = "email" | "url" | "path" | "number" | "text";

export function valueShape(value: string): ValueShape {
  const v = value.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "email";
  if (/^https?:\/\/\S+$/.test(v)) return "url";
  if (/^[~./][^\s]*$/.test(v)) return "path";
  if (/^-?\d+(\.\d+)?$/.test(v)) return "number";
  return "text";
}

// A captured value runs to the end of the sentence, so the ONLY punctuation to
// remove is a single trailing terminator. Excluding "." from the capture class
// instead (the obvious-looking shortcut) silently breaks every email, URL and
// path — which is exactly what happened before a test caught it.
function trimTerminator(value: string): string {
  return value
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
}

function keyFromField(field: string): string {
  return `user.${normalizeRef(field).replace(/\s+/g, "_")}`;
}

// Style/format preferences read as preferences; everything else labelled with
// "my X is Y" is a semantic fact about the user.
const PREFERENCE_FIELDS =
  /\b(style|format|tone|language|voice|verbosity|units|timezone|time zone)\b/i;

const RULES: {
  name: string;
  re: RegExp;
  build: (m: RegExpMatchArray) => {
    memory_type: MemoryType;
    memory_key: string | null;
    content: string;
    structured_value: Record<string, unknown>;
  } | null;
}[] = [
  {
    // "I prefer concise technical answers." / "I like short replies."
    name: "stated_preference",
    re: /\bi (?:prefer|like|want|'d like)\s+(.{3,160}?)\s*[.!]?$/i,
    build: (m) => ({
      memory_type: "preference",
      memory_key: "user.response_style",
      content: `Prefers ${trimTerminator(m[1])}`,
      structured_value: { value: trimTerminator(m[1]) },
    }),
  },
  {
    // "My billing email is finance@example.com." — a labelled mutable fact.
    name: "labelled_fact",
    re: /\bmy ([a-z][a-z ]{2,40}?) is (?:now )?(\S.{0,200})$/i,
    build: (m) => {
      const field = m[1].trim();
      const value = trimTerminator(m[2]);
      if (!value) return null;
      return {
        memory_type: PREFERENCE_FIELDS.test(field) ? "preference" : "semantic",
        memory_key: keyFromField(field),
        content: `${field} is ${value}`,
        structured_value: { field, value },
      };
    },
  },
  {
    // "Remember that the deploy script lives in scripts/deploy.sh"
    name: "explicit_remember",
    re: /\b(?:remember|note) (?:that )?(.{5,200}?)\s*[.!]?$/i,
    build: (m) => ({
      memory_type: "semantic",
      memory_key: null,
      content: trimTerminator(m[1]),
      structured_value: {},
    }),
  },
];

// An unlabelled correction: "Use finance@example.com now." It only supersedes
// when EXACTLY ONE active memory holds a value of the same shape — otherwise the
// referent is a guess, and a guess must not retire a fact.
// The update marker ("now" / "instead" / "from now on") is REQUIRED: without it
// "use the exporter" is an instruction for this turn, not a correction to a
// stored fact.
const CORRECTION_RE =
  /\b(?:use|switch to|change (?:it )?to|make it)\s+(\S.{0,160}?)\s+(?:now|instead|from now on)\s*[.!?]*$/i;

export const DETERMINISTIC_EXTRACTOR_VERSION = "rules-1";

// The NARROWEST allowed scope wins — a thread sits inside an agent sits inside
// the vault. Preferring the widest (this took `agent ?? vault ?? [0]`) turned a
// sentence said in one thread into a vault fact every other thread and agent
// could read: extraction may never choose a scope wider than the event it read.
//
// The corollary has to be enforced too, or the invariant is just a convention the
// one caller happens to honour: a list that names SOME OTHER thread was not
// assembled for this event, so it earns no proposal at all. Falling through to
// agent/vault is how `[thread:tB, vault]` on a tA event committed at vault and
// `[thread:tB, agent:ag1]` committed at agent — widening in the exact case where
// the caller's own list says this event's thread was not on offer. A list with no
// thread scope in it is a different statement (a sweep deliberately writing agent
// or vault facts), and stays allowed.
function scopeForEvent(
  allowedScopes: ExtractorInput["allowedScopes"],
  threadId: string,
): { scopeType: ScopeType; scopeId: string | null } | null {
  const own = allowedScopes.find((s) => s.scopeType === "thread" && s.scopeId === threadId);
  if (own) return own;
  if (allowedScopes.some((s) => s.scopeType === "thread")) return null;
  return (
    allowedScopes.find((s) => s.scopeType === "agent") ??
    allowedScopes.find((s) => s.scopeType === "vault") ??
    null
  );
}

// Whether an event carries the USER's own words — decided from provenance the
// caller cannot choose, not from the event type, which is just an argument.
// `source` is stamped by the WRITER (tools.ts sets `tool:*` itself and does not
// expose the field in any input schema), so it is the one column an agent cannot
// forge. A user_message written by anything else is a RELAY of the user: it may
// propose, never auto-commit — and because a non-explicit write cannot supersede,
// a relayed value CONFLICTS with what the user actually said instead of retiring
// it.
//
// Fail-closed on an unrecognized source: the contract for event writers is that
// the user's own transport stamps nothing or `user:<transport>`, and every other
// writer stamps its own name. A writer that forgets the contract degrades to a
// candidate rather than inheriting the user's authority.
function speaksForUser(event: ConversationEvent): boolean {
  return (
    event.event_type === "user_message" &&
    // actor_type is DERIVED from the type in events.ts, so a row where the two
    // disagree never passed through that chokepoint at all.
    event.actor_type === "user" &&
    (!event.source || event.source.startsWith("user:"))
  );
}

export const deterministicExtractor: MemoryExtractor = {
  version: DETERMINISTIC_EXTRACTOR_VERSION,
  async extract({ events, activeMemories, allowedScopes }) {
    const proposals: MemoryProposal[] = [];

    for (const event of events) {
      // Only the user speaks for the user. An assistant_message is a suggestion,
      // and a tool_result is an observation.
      if (event.event_type !== "user_message") continue;
      const scope = scopeForEvent(allowedScopes, event.thread_id);
      if (!scope) continue;
      const text = event.content.trim();
      if (!text || findSecrets(text).length) continue;
      // The instruction screen reads the RAW sentence — what the user actually
      // wrote — because every rule below hands the screen its own residue. The
      // explicit_remember rule strips "Remember that " and the correction rule
      // keeps only the captured value, so safety.ts's pattern for
      // "remember that every agent is allowed …" could never fire: that sentence
      // laundered itself into a COMMITTED memory granting permission, and every
      // "remember that <policy>" took the same route. Screening once here covers
      // every rule, including ones added later.
      //
      // Coarse on purpose: a fact stated in the same breath as an instruction
      // yields nothing, rather than a guess at where the instruction ends. The
      // sentence is still in the event log and still searchable — it just cannot
      // become memory.
      if (looksLikeInstruction(text)) continue;
      // Trust is a property of the event, not of its type. A user_message some
      // tool wrote is a relay; it may propose, not auto-commit.
      const explicit = speaksForUser(event);

      let matched = false;
      for (const rule of RULES) {
        const m = text.match(rule.re);
        if (!m) continue;
        const built = rule.build(m);
        if (!built) continue;
        // Still screened after the build, on top of the raw screen above: a build
        // CONCATENATES fragments ("field is value"), so it can form a phrase
        // neither the raw sentence nor either fragment contained.
        if (looksLikeInstruction(built.content)) continue;
        proposals.push({
          operation: "ADD",
          scope_type: scope.scopeType,
          scope_id: scope.scopeId,
          ...built,
          source_event_ids: [event.id],
          confidence: explicit ? 0.9 : 0.5,
          salience: built.memory_type === "preference" ? 0.7 : 0.5,
          explicit,
        });
        matched = true;
        break;
      }
      if (matched) continue;

      // Unlabelled correction.
      const c = text.match(CORRECTION_RE);
      if (!c) continue;
      const value = trimTerminator(c[1]);
      if (!value) continue;
      if (looksLikeInstruction(value) || findSecrets(value).length) continue;
      const shape = valueShape(value);
      if (shape === "text") continue; // too vague to attach to a key safely
      const candidates = activeMemories.filter((m) => {
        const v = m.structured_value?.value;
        return (
          typeof v === "string" &&
          valueShape(v) === shape &&
          m.memory_key &&
          // Same scope this event writes to. A SUPERSEDE inserts a NEW row in the
          // TARGET's scope, so letting a thread correction retire a vault fact
          // publishes that thread's value globally exactly as an ADD would.
          m.scope_type === scope.scopeType &&
          (m.scope_id ?? "") === (scope.scopeId ?? "")
        );
      });
      if (candidates.length !== 1) continue; // ambiguous referent: leave it alone
      const target = candidates[0];
      const field = String(target.structured_value.field ?? target.memory_key);
      proposals.push({
        operation: "SUPERSEDE",
        scope_type: target.scope_type,
        scope_id: target.scope_id,
        memory_type: target.memory_type,
        memory_key: target.memory_key,
        content: `${field} is ${value}`,
        structured_value: { field, value },
        source_event_ids: [event.id],
        confidence: explicit ? 0.9 : 0.5,
        salience: target.salience,
        explicit,
      });
    }
    return { proposals };
  },
};

// --- the extraction job ------------------------------------------------------

export interface ExtractionResult {
  threadId: string;
  fromSequence: number;
  throughSequence: number;
  proposals: number;
  applied: { operation: string; status: string; memoryId: string | null; reason?: string }[];
}

async function activeMemoriesFor(
  db: Db,
  scopes: { scopeType: ScopeType; scopeId: string | null }[],
): Promise<MemoryItem[]> {
  if (scopes.length === 0) return [];
  const rows = await db.query(
    `SELECT * FROM memory_items
     WHERE status = 'committed'
       AND (scope_type, coalesce(scope_id, '')) IN (
         SELECT * FROM unnest($1::text[], $2::text[])
       )
     ORDER BY updated_at DESC LIMIT 200`,
    [scopes.map((s) => s.scopeType), scopes.map((s) => s.scopeId ?? "")],
  );
  return rows.rows.map(rowToMemory);
}

// Runs extraction for one thread from its checkpoint forward. Idempotent: the
// checkpoint only advances after the proposals are applied, and every proposal
// is fingerprinted, so a retry that re-reads the same events is a NOOP rather
// than a duplicate.
export async function runExtraction(
  db: Db,
  extractor: MemoryExtractor,
  args: {
    threadId: string;
    summary?: StructuredSummary | null;
    allowedScopes?: { scopeType: ScopeType; scopeId: string | null }[];
    limit?: number;
  },
): Promise<ExtractionResult> {
  const cp = await db.query(
    `INSERT INTO extraction_checkpoints (thread_id) VALUES ($1)
     ON CONFLICT (thread_id) DO UPDATE SET updated_at = now()
     RETURNING last_extracted_sequence`,
    [args.threadId],
  );
  const from = Number(cp.rows[0].last_extracted_sequence);
  const events = await getConversationEvents(db, {
    threadId: args.threadId,
    fromSequence: from,
    limit: Math.min(Math.max(Number(args.limit) || 200, 1), 500),
  });
  if (events.length === 0) {
    return {
      threadId: args.threadId,
      fromSequence: from,
      throughSequence: from,
      proposals: 0,
      applied: [],
    };
  }

  const scopes =
    args.allowedScopes && args.allowedScopes.length > 0
      ? args.allowedScopes
      : [{ scopeType: "thread" as ScopeType, scopeId: args.threadId }];
  const active = await activeMemoriesFor(db, scopes);
  const { proposals } = await extractor.extract({
    events,
    summary: args.summary ?? null,
    activeMemories: active,
    allowedScopes: scopes,
  });

  const applied: ExtractionResult["applied"] = [];
  for (const p of proposals) {
    // A proposal may only target a scope the caller allowed. This is the guard
    // that stops an extractor (or a model behind one) from widening scope.
    //
    // Thread scope has a second condition the allow-list cannot express: these
    // events all came from args.threadId, so a proposal at thread:<other> would
    // land a sentence said here where a sibling thread reads it — even though the
    // caller "allowed" that thread. `scopeForEvent` already declines such a list,
    // so this exists for whatever is behind the interface next.
    const permitted =
      scopes.some(
        (s) => s.scopeType === p.scope_type && (s.scopeId ?? "") === (p.scope_id ?? ""),
      ) &&
      (p.scope_type !== "thread" || p.scope_id === args.threadId);
    if (!permitted) {
      applied.push({
        operation: "REJECT",
        status: "rejected",
        memoryId: null,
        reason: `scope ${p.scope_type}:${p.scope_id ?? ""} not allowed`,
      });
      continue;
    }
    const res = await writeMemory(db, {
      scopeType: p.scope_type,
      scopeId: p.scope_id,
      memoryType: p.memory_type,
      memoryKey: p.memory_key,
      content: p.content,
      structuredValue: p.structured_value,
      sourceEventIds: p.source_event_ids,
      confidence: p.confidence,
      salience: p.salience,
      explicit: p.explicit,
      createdBy: `extractor:${extractor.version}`,
    });
    applied.push({
      operation: res.operation,
      status: res.status,
      memoryId: res.memory?.id ?? null,
      reason: res.reason,
    });
  }

  const through = events[events.length - 1].sequence;
  await db.query(
    `UPDATE extraction_checkpoints
     SET last_extracted_sequence = $2, last_run_at = now(), last_error = NULL, updated_at = now()
     WHERE thread_id = $1`,
    [args.threadId, through],
  );
  return {
    threadId: args.threadId,
    fromSequence: from,
    throughSequence: through,
    proposals: proposals.length,
    applied,
  };
}
