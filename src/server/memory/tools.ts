// The agent-facing memory tools: remember, recall, forget, inspect_memory.
//
// Three rules shape these signatures:
//
//   ONE SCOPE SHAPE. Every tool here — writer and reader alike — publishes the
//   SAME four scope fields and resolves them with the SAME parser, and neither
//   is done by the tool: `scoped()` bolts the fields onto the schema and runs
//   the parse in front of the handler, and MEMORY_TOOLS is CONSTRUCTED from that
//   wrapper rather than written out. A handler therefore never sees
//   a.thread_id / a.scope_id at all; it is handed a resolved CallScope. That is
//   the fix for write-only memory: a writer's parser and a reader's parser
//   cannot drift apart when there is only one parser. What drifted before:
//   `remember` published scope/scope_id/thread_id and stored under scope_id,
//   while `recall` published thread_id/agent_id and read neither — so
//   remember({scope_id:'x'}) answered saved:true with a memory that no spelling
//   of recall, inspect_memory or get_page could ever return.
//
//   The server decides scope and filters. A caller asks for "agent scope" and
//   names its agent; it cannot pass a database predicate, widen a scope, or
//   select rows the policy would exclude. Anything an LLM controls is a request,
//   not a query. Naming a scope WIDER than the one the call is working in
//   (scope:'vault' alongside a thread_id) is refused rather than honoured: the
//   vault is readable from every thread and every agent, so committing there is
//   publishing, and publishing has to be the whole intent of the call.
//
//   `remember` never says "saved" when it did not save. Its result distinguishes
//   committed / candidate / conflict / rejected, because an agent that believes a
//   candidate was committed will confidently tell the user something untrue.
//
//   Nothing here claims to be the user. A tool call carries the caller's words,
//   not the user's, so every write leaves these handlers non-explicit and every
//   event they append is stamped with a `tool:` source THIS FILE sets. The gate
//   that matters (events.ts, items.ts) then decides from that provenance instead
//   of from a flag the caller could have chosen.

import type { Db } from "../db";
import type { Access, BrainCtx, ToolDef } from "../mcp";
import type { EventType } from "./events";
import {
  IMPLIED_ACTOR,
  appendConversationEvent,
  ensureThread,
  getConversationEvents,
  getThread,
} from "./events";
import type { MemoryItem, MemoryType, ScopeType } from "./items";
import { commitCandidate, getMemory, inspectMemory, revokeMemory, writeMemory } from "./items";
import { projectMemory } from "./projection";
import { recallMemory, searchMemoryByKey, shouldRetrieveMemory } from "./recall";
import { screenMemoryContent } from "./safety";
import { getActiveThreadSummary, getThreadSummaryHistory, refreshThreadSummary } from "./summary";

interface SchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

const obj = (props: Record<string, unknown>, required: string[] = []): SchemaObject => ({
  type: "object",
  properties: props,
  ...(required.length ? { required } : {}),
});

const SCOPE_ENUM = ["thread", "agent", "vault"];
const TYPE_ENUM = ["semantic", "preference", "episodic", "procedural", "working_state"];

// What a tool may append: everything whose implied actor is not the user. Taken
// from the actor table so the tool surface and the invariant events.ts enforces
// cannot disagree — a hand-written second list is how `user_message` stayed
// callable while the comment above it said only the user speaks for the user.
const TOOL_APPENDABLE_EVENTS = (Object.keys(IMPLIED_ACTOR) as EventType[]).filter(
  (t) => IMPLIED_ACTOR[t] !== "user",
);

type Scope = { scopeType: ScopeType; scopeId: string | null };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// THE ONE READER of a caller-supplied string argument. A field that is PRESENT
// but not a string is refused, never read as absent. `str()` alone cannot tell
// those apart, and treating them the same failed open: `scope: ["thread"]`, `1`,
// `{s:"thread"}` and `true` all became "no scope named" and fell through to the
// bare-scope_id inference, so the call landed at AGENT scope and reported
// saved:true — while the mere typo `scope:"thred"` was correctly refused. A type
// error must not be the quiet way to an outcome a typo cannot reach.
// null/undefined/omitted still mean absent, which is what a JSON client sends
// for a field it is not using.
//
// APPLIED TO EVERY STRING ARGUMENT, not to the scope fields it was written for.
// Round 4 fixed the four scope fields and left this file with FOUR OTHER
// spellings of the same read — `str(a.x)`, `String(a.x ?? "")`,
// `typeof a.x === "string" ? a.x : undefined`, and an enum test through
// `String()` — which is the list shape that has lost every round here. The one
// that mattered was `memory_key`: `remember({memory_key:["user.billing_email"]})`
// dropped the key, stored the row UNKEYED, and so walked past the `conflict` the
// identical string spelling earns — committing a second "billing email" beside
// the user's, which `forget({memory_key:"user.billing_email"})` then could not
// reach, because the row it planted has no key. Meanwhile `forget` read the same
// non-string value as "not supplied" and refused the call outright: two readers
// of one field, opposite verdicts.
function argString(name: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    const kind = Array.isArray(v)
      ? "an array"
      : typeof v === "object"
        ? "an object"
        : `a ${typeof v}`;
    throw new Error(`${name} must be a string, not ${kind}`);
  }
  return str(v);
}

// The same rule for a list of strings: every element goes through argString, so
// a non-string hiding inside an array is refused where it is read rather than
// coerced somewhere later.
function argStringList(name: string, v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${name} must be an array of strings`);
  return v.map((x, i) => argString(`${name}[${i}]`, x)).filter((x): x is string => x !== null);
}

// The same rule for a boolean. `Boolean(a.x)` and a bare `if (a.x)` read the
// value by TRUTHINESS, so the string "false" — a spelling an LLM emits
// constantly — turned the flag ON: `get_summary({history:"false"})` returned the
// version history and `recall({expand_graph:"false"})` expanded the graph. A
// present-but-non-boolean value is a type error, and a type error must not be the
// quiet way to an outcome the caller did not ask for.
function argBool(name: string, v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new Error(`${name} must be a boolean, not a ${typeof v}`);
  return v;
}

// The same rule for a field whose value must come from a fixed set: absent takes
// the documented default, an unrecognised value is REFUSED rather than coerced.
// `TYPE_ENUM.includes(String(a.memory_type)) ? … : "semantic"` silently rewrote a
// typo — and every non-string — into a different memory type, which is the exact
// failure the scope parser refuses to make one function above.
function argEnum(name: string, v: unknown, allowed: readonly string[], fallback: string): string {
  const s = argString(name, v);
  if (s === null) return fallback;
  if (!allowed.includes(s))
    throw new Error(`unknown ${name}: expected one of ${allowed.join(", ")}`);
  return s;
}

const sameScope = (a: Scope, b: Scope): boolean =>
  a.scopeType === b.scopeType && (a.scopeId ?? "") === (b.scopeId ?? "");

// Where a call is. The ONLY scope a handler ever sees — it gets this instead of
// the caller's raw fields, so there is nothing left for a handler to re-derive
// its own way.
export interface CallScope {
  /** Where a write lands, and the scope a by-id or by-key operation reaches. */
  target: Scope;
  /** What a read may see: the target plus the broader scopes the caller named. */
  readable: Scope[];
  /** The ONE thread this call may touch. Derived from the scope, never taken raw. */
  threadId: string;
  /** The agent that owns — or, on the first write, claims — that thread. */
  agentId: string | null;
}

// Threads the SERVER mints, for the scopes that are not threads. An agent
// working at agent scope still produces events, and they used to land in one
// hardcoded thread called 'direct': a shared bucket that every scope's content
// fell into and that ANY caller could name, so list_events({thread_id:'direct'})
// handed a sibling agent the verbatim content of a memory the memory tools
// correctly hid from it. Each scope now owns its own thread in a namespace no
// caller may name, which is what makes "reachable only by naming the scope it
// was written at" true of events as well as of memories.
const SCOPE_THREAD_PREFIX = "scope:";

function scopeThreadId(s: Scope): string {
  return s.scopeType === "vault"
    ? `${SCOPE_THREAD_PREFIX}vault`
    : `${SCOPE_THREAD_PREFIX}${s.scopeType}:${s.scopeId}`;
}

// Two fields that name the same thing must not name two different things. A
// call works in ONE scope, so when the arguments disagree the server does not
// get to guess which one the caller meant — that guess is how
// remember({scope:'thread', scope_id:'victim', thread_id:'mine'}) stored a
// sentence in a sibling thread and hid it from the thread that said it.
function one(what: string, a: string | null, b: string | null): string | null {
  if (a && b && a !== b) throw new Error(`conflicting ${what}: the arguments name two scopes`);
  return a ?? b;
}

// THE parser. One scope shape for every tool: `thread_id` names a thread,
// `agent_id` (or a bare `scope_id`) names an agent, `scope:'vault'` names the
// vault, and `scope` + `scope_id` is just another spelling of the same two
// fields. Every spelling that can WRITE a scope can also READ it, which is
// checked below rather than believed.
async function resolveCallScope(
  db: Db,
  a: Record<string, unknown>,
  access: Access,
): Promise<CallScope> {
  const requested = one(
    "scope",
    argString("scope", a.scope),
    argString("scope_type", a.scope_type),
  );
  if (requested !== null && !SCOPE_ENUM.includes(requested)) {
    // Not coerced to a default. The old fallback turned any unrecognised scope
    // into 'agent', so a typo silently changed which rows a call touched.
    throw new Error(`unknown scope: expected one of ${SCOPE_ENUM.join(", ")}`);
  }
  const scopeId = argString("scope_id", a.scope_id);
  let namedThread = argString("thread_id", a.thread_id);
  let namedAgent = argString("agent_id", a.agent_id);
  if (requested === "thread") {
    namedThread = one("thread", scopeId, namedThread);
    if (!namedThread) throw new Error("scope 'thread' needs an id: pass thread_id");
  } else if (requested === "agent") {
    namedAgent = one("agent", scopeId, namedAgent);
    if (!namedAgent) throw new Error("scope 'agent' needs an id: pass agent_id");
  } else if (requested === "vault") {
    // The vault has exactly one instance, so it has no id. Carrying one would
    // store a scope_id every reader looks for as '' and never matches.
    if (scopeId) throw new Error("scope 'vault' takes no id: the vault is one shared scope");
  } else if (scopeId) {
    // A bare scope_id means the AGENT scope — in EVERY tool, so a writer and a
    // reader that both spell it this way name the same scope.
    namedAgent = one("agent", scopeId, namedAgent);
  }
  if (namedThread?.toLowerCase().startsWith(SCOPE_THREAD_PREFIX)) {
    throw new Error(
      `thread ids beginning with '${SCOPE_THREAD_PREFIX}' are reserved for scope-owned threads`,
    );
  }

  // Thread ownership is the DB's answer, not the caller's claim: it is written
  // once, when the thread is created, and never changes (see ensureThread). A
  // caller that names a thread AND an agent that does not own it is trying to
  // read or write another agent's log.
  let owner: string | null = null;
  if (namedThread) {
    owner = (await getThread(db, namedThread))?.agent_id ?? null;
    if (owner && namedAgent && owner !== namedAgent) {
      throw new Error("forbidden: that thread belongs to another agent");
    }
  }

  // The position: the NARROWEST scope the caller named. Narrowest by default is
  // the safe direction — a memory kept in the thread it was said in can always
  // be published later, and one published by accident cannot be unpublished.
  const position: Scope = namedThread
    ? { scopeType: "thread", scopeId: namedThread }
    : namedAgent
      ? { scopeType: "agent", scopeId: namedAgent }
      : { scopeType: "vault", scopeId: null };

  if (access === "write" && position.scopeType === "vault" && requested !== "vault") {
    // A write that named nothing would land in the widest scope BY DEFAULT.
    throw new Error("name the scope this write belongs to: thread_id, agent_id, or scope:'vault'");
  }

  // The target is the position, with exactly one exception: a caller inside a
  // thread may operate at the scope of the agent that OWNS that thread. That is
  // not a widening the caller performed — the ownership came from the database
  // above. The vault is never reachable that way: nobody owns it, so it has to
  // be named alone.
  let target = position;
  if (requested === "agent" && namedAgent) target = { scopeType: "agent", scopeId: namedAgent };
  if (requested === "vault") {
    if (namedThread || namedAgent) {
      throw new Error(
        "scope 'vault' is wider than the scope this call works in: drop thread_id/agent_id to work in the vault",
      );
    }
    target = { scopeType: "vault", scopeId: null };
  }

  const readable: Scope[] = [{ scopeType: "vault", scopeId: null }];
  if (namedAgent) readable.push({ scopeType: "agent", scopeId: namedAgent });
  if (namedThread) readable.push({ scopeType: "thread", scopeId: namedThread });

  // saved:true has to MEAN readable. Every target must be one of the scopes a
  // read with the same arguments can see, or this surface is handing back
  // write-only memory again. Checked on every call rather than argued for in a
  // comment: a spelling added later that reaches a new target without reaching
  // its reader dies here instead of in production.
  if (!readable.some((s) => sameScope(s, target))) {
    throw new Error("internal: the target scope is not readable from the same arguments");
  }

  return {
    target,
    readable,
    threadId: namedThread ?? scopeThreadId(position),
    agentId: namedAgent ?? owner,
  };
}

// A memory is reachable only through a scope the caller named. A raw memory_id
// carries no scope at all, so without this check `forget(<id>)` and
// `inspect_memory(<id>)` reach another agent's or another thread's memory —
// exactly the widening an LLM must never be able to do.
function visibleIn(memory: MemoryItem, scopes: Scope[]): boolean {
  return scopes.some((s) =>
    sameScope(s, { scopeType: memory.scope_type, scopeId: memory.scope_id }),
  );
}

// The scope block, published verbatim by every tool below. One block, so a
// writer and a reader cannot advertise different names for the same thing —
// which is what taught an agent to save with `scope_id` and then look for it
// with `agent_id`, a field remember did not even offer.
const SCOPE_FIELDS: Record<string, unknown> = {
  scope: {
    type: "string",
    enum: SCOPE_ENUM,
    description:
      "Which scope this call works in. Defaults to the narrowest one you named. " +
      "'vault' is shared with every thread and agent and must be named on its own.",
  },
  scope_id: {
    type: "string",
    description: "The id for `scope`: a thread id, or an agent id. On its own it means an agent.",
  },
  thread_id: { type: "string", description: "Thread scope: the thread this call is working in." },
  agent_id: { type: "string", description: "Agent scope: the agent this call is working as." },
};

// A tool as WRITTEN: same as ToolDef except the handler is handed the resolved
// scope and never the caller's scope fields.
interface ScopedToolDef {
  access: Access;
  description: string;
  inputSchema: SchemaObject;
  handler: (ctx: BrainCtx, args: Record<string, unknown>, scope: CallScope) => Promise<unknown>;
}

// THE chokepoint. Every entry of MEMORY_TOOLS is built by this function, so
// every tool publishes the same scope fields and every call is parsed by the
// same parser before its handler exists. SCOPE_FIELDS is spread LAST: a tool
// cannot publish its own spelling of a scope field and drift from the parse.
function scoped(def: ScopedToolDef): ToolDef {
  return {
    access: def.access,
    description: def.description,
    inputSchema: {
      ...def.inputSchema,
      properties: { ...def.inputSchema.properties, ...SCOPE_FIELDS },
    },
    handler: async (c, a) => def.handler(c, a, await resolveCallScope(c.db, a, def.access)),
  };
}

const SCOPED_MEMORY_TOOLS: Record<string, ScopedToolDef> = {
  remember: {
    access: "write",
    description:
      "Save one durable memory, under your own name. The result says what actually happened: " +
      "committed, candidate (needs approval), conflict (contradicts an active memory), or " +
      "rejected (e.g. contained a credential) — a candidate is NOT saved as fact. An UNKEYED " +
      "note commits, because it displaces nothing. A memory_key groups a value that changes " +
      "(user.billing_email), and a keyed write from a tool lands as a candidate, or as a " +
      "conflict when that key already holds a value: retiring something the USER said needs the " +
      "user, not an agent relaying it. It saves in the scope you name — thread_id, agent_id (or " +
      "scope_id), or scope:'vault' — and recall / inspect_memory / forget with that SAME field " +
      "read it back. Naming a scope wider than the one you are working in is refused.",
    inputSchema: obj(
      {
        content: { type: "string" },
        memory_type: { type: "string", enum: TYPE_ENUM },
        memory_key: { type: "string" },
        structured_value: { type: "object" },
      },
      ["content"],
    ),
    handler: async (c: BrainCtx, a, s) => {
      const { scopeType, scopeId } = s.target;
      const content = argString("content", a.content) ?? "";
      if (!content) throw new Error("content is required");
      const memoryType = argEnum("memory_type", a.memory_type, TYPE_ENUM, "semantic") as MemoryType;
      // EVERY caller-supplied argument is read HERE, before anything durable
      // happens. memory_key used to be read 29 lines further down, at the
      // writeMemory call — after the immutable provenance event had already been
      // appended — so `remember({memory_key:["k"], content:"…"})` threw
      // "memory_key must be a string" and STILL left the content in
      // conversation_events, which has no delete path and which context.ts packs
      // into every subsequent context window for that thread. Four refused
      // retries left four rows. That is the rule mcp.ts states for itself one
      // layer up — "a rule that runs after the write is not a rule" — broken
      // inside a handler. The control that proves it was ordering and not policy:
      // memory_type is read on the line above and its refusal leaves zero rows.
      const memoryKey = argString("memory_key", a.memory_key);
      const structuredValue = (a.structured_value as Record<string, unknown>) ?? {};

      // Screen the WHOLE call, before anything durable happens. Handing the raw
      // args over as one payload is the point: the field that leaked last time
      // (`memory_key`) was not exotic, it was simply not on the enumerated list
      // — and it reaches memory_items.memory_key, the projection's title, body
      // and FTS index, and every future context window.
      //
      // ponytail: this runs the PROSE detectors over handles too, so a bare
      // 13-19 digit, Luhn-valid thread_id/scope_id reads as a card and is
      // refused. Accepted: such an id is indistinguishable from a card by
      // anything cheap, and the alternative — exempting one detector from part
      // of the payload — rebuilds the enumerated list this replaces.
      const screen = screenMemoryContent({
        content,
        memoryType,
        // A tool never speaks for the user; see the note on writeMemory below.
        explicit: false,
        structuredValue,
        callerPayload: a,
      });

      // A remember IS an observable action, so it becomes an event and the memory
      // cites it. That is how a tool-created memory gets real provenance instead
      // of being a fact from nowhere.
      //
      // It is an agent_action with a `tool:` source, NOT a user_message: only the
      // user speaks for the user (extract.ts trusts user_message as the one
      // source that does), and events.ts refuses a tool-sourced user event, so
      // this cannot be turned into a forged statement. Secret text is withheld
      // whole by that same chokepoint — layer 1 has no delete path — while the
      // memory write below is refused outright rather than laundered into a
      // memory reading "[withheld:…]".
      //
      // The thread comes from the resolved scope, NOT from a.thread_id with a
      // hardcoded 'direct' behind it: that default put the verbatim content of
      // every agent-scoped remember into one thread every caller could read.
      await ensureThread(c.db, s.threadId, s.agentId ?? undefined);
      const { event } = await appendConversationEvent(c.db, {
        threadId: s.threadId,
        eventType: "agent_action",
        content,
        source: "tool:remember",
      });
      if (!screen.allow) {
        return {
          outcome: "rejected",
          operation: "REJECT",
          memory_id: null,
          saved: false,
          superseded_id: null,
          conflicts_with: null,
          projection: null,
          reason: screen.reason,
        };
      }

      // explicit:false, always. `explicit` means "the user said it themselves",
      // which is the authority to auto-commit AND to supersede; passing it from
      // here let one tool call retire a value the user had actually stated. The
      // caller cannot influence this, so the SUPERSEDE branch of writeMemory is
      // unreachable from this tool: a keyed write gets candidate (free key) or
      // conflict (taken key) instead.
      const res = await writeMemory(c.db, {
        scopeType,
        scopeId,
        memoryType,
        memoryKey,
        content,
        structuredValue,
        sourceEventIds: [event.id],
        explicit: false,
        createdBy: "tool:remember",
      });

      // Storing the agent's OWN note and retiring the user's fact are different
      // authorities, and `explicit` conflated them. The tool has the first: an
      // UNKEYED add can never displace anything, because writeMemory only looks
      // for an active row when a memory_key is given — so it is committed here
      // under the tool's own name, at the confidence of an inferred write, with
      // provenance pointing at the agent_action above. The guard is the stored
      // row's key, not the caller's argument, and `downgrade` is checked so that
      // any OTHER reason to hold a write back (instruction-shaped content,
      // external content, whatever safety.ts learns next) still holds it back.
      let memory = res.memory;
      let status: string = res.status;
      let reason = res.reason;
      if (
        memory &&
        res.operation === "ADD" &&
        res.status === "candidate" &&
        !memory.memory_key &&
        screen.downgrade === "not_explicit"
      ) {
        const promoted = await commitCandidate(c.db, {
          memoryId: memory.id,
          actor: "tool:remember",
          reason: "stored by the agent under its own name; displaces nothing",
        });
        memory = promoted.memory ?? memory;
        status = promoted.status;
        reason = promoted.reason;
      }

      // Project immediately so the memory is searchable in the same turn; a
      // failure here leaves the canonical record committed and reports honestly.
      let projection: string | null = null;
      if (memory && status === "committed") {
        const p = await projectMemory(c.db, c.store, memory);
        projection = p.status;
      }
      return {
        outcome: status,
        operation: res.operation,
        memory_id: memory?.id ?? null,
        // Deliberately explicit: "saved" is only true for committed.
        saved: status === "committed",
        superseded_id: res.superseded?.id ?? null,
        conflicts_with: res.conflictsWith?.id ?? null,
        projection,
        reason,
      };
    },
  },

  recall: {
    access: "read",
    description:
      "Retrieve durable memories relevant to a query. Only ACTIVE memories are returned; pass " +
      "as_of (ISO timestamp) for historical lookup ('what was it before it changed'). Scope is " +
      "named exactly as in remember (thread_id / agent_id / scope_id / scope) and decided by the " +
      "server — it cannot be widened by the caller. Broader scopes are visible from a narrower " +
      "one: a thread sees its own, its agent's and the vault's memories.",
    inputSchema: obj(
      {
        query: { type: "string" },
        limit: { type: "number" },
        as_of: { type: "string", description: "ISO timestamp for historical recall." },
        expand_graph: { type: "boolean" },
        memory_type: { type: "string", enum: TYPE_ENUM },
      },
      ["query"],
    ),
    handler: async (c: BrainCtx, a, s) => {
      const asOf = argString("as_of", a.as_of) ?? undefined;
      const results = await recallMemory(c.db, c.store, {
        query: argString("query", a.query) ?? "",
        scopes: s.readable,
        limit: a.limit as number,
        asOf,
        expandGraph: argBool("expand_graph", a.expand_graph),
        types:
          a.memory_type === undefined || a.memory_type === null
            ? undefined
            : [argEnum("memory_type", a.memory_type, TYPE_ENUM, "semantic") as MemoryType],
      });
      return {
        mode: asOf ? "historical" : "current",
        as_of: asOf ?? null,
        count: results.length,
        memories: results.map((r) => ({
          id: r.memory.id,
          type: r.memory.memory_type,
          scope: r.memory.scope_type,
          memory_key: r.memory.memory_key,
          content: r.memory.content,
          status: r.memory.status,
          effective_from: r.memory.valid_from,
          effective_to: r.memory.valid_to,
          confidence: r.memory.confidence,
          via: r.via,
        })),
      };
    },
  },

  forget: {
    access: "write",
    description:
      "Revoke a memory by id, or by memory_key, within the scope you name — the same fields " +
      "remember and recall take. A memory outside that scope reads as not_found. It leaves " +
      "active retrieval immediately; the revision history is kept, and the generated page is " +
      "cleaned up. `forgotten` is true only when the page was retracted too.",
    inputSchema: obj({
      memory_id: { type: "string" },
      memory_key: { type: "string" },
      reason: { type: "string" },
      authorizing_event_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Event ids in THIS thread that authorize the revocation. A memory the user " +
          "stated can only be revoked by citing the user's own words asking for it.",
      },
    }),
    handler: async (c: BrainCtx, a, s) => {
      // Every revocation names its scope, the memory_id path included: a bare id
      // is a scope-free handle, and this is the path that takes a fact away from
      // everyone else's retrieval.
      const scope = s.target;
      let ids: string[] = [];
      const memoryId = argString("memory_id", a.memory_id);
      const memoryKey = argString("memory_key", a.memory_key);
      if (memoryId) {
        ids = [memoryId];
      } else if (memoryKey) {
        const found = await searchMemoryByKey(c.db, { memoryKey, scopes: [scope] });
        ids = found.map((m) => m.id);
      } else {
        throw new Error("memory_id or memory_key is required");
      }

      // THE USER'S OWN DOOR. mayAmend (items.ts) refuses an agent-surface change
      // to a memory the user stated "unless the change itself carries the user's
      // words" — and revokeMemory has taken `sourceEventIds` for exactly that
      // since it was written, but this handler never passed any. The rule
      // therefore had no satisfying case: `forget` always stamped `tool:forget`,
      // it is the only revocation surface (READ_ONLY_TOOLS has no `forget`, and
      // /api/maintenance never revokes), so a user-stated memory could not be
      // revoked by anyone, through anything, ever. AGENTS.md meanwhile documents
      // `forget` as THE recovery for a wrong memory.
      //
      // WHICH THREADS MAY BE CITED FOLLOWS THE SCOPE BEING REVOKED, not the
      // thread the call happens to have. Keying it on `s.threadId` was wrong in
      // both directions at once, and an adversarial pass demonstrated both:
      //   TOO LOOSE — `s.target` and `s.threadId` come from different arguments,
      //   so `forget({scope:'agent', agent_id:'A', thread_id:'t-chat', …})`
      //   revoked an AGENT-scope memory while citing a user message borrowed from
      //   any unowned conversation thread the caller could name.
      //   TOO TIGHT — a vault-scope call always works in the minted thread
      //   `scope:vault`, and no caller may name a `scope:`-prefixed thread, so no
      //   citation was reachable for the vault AT ALL. Vault is the only scope
      //   with a projected page, i.e. the only content a BRAIN_READ_TOKEN holder
      //   can search, so the one case AGENTS.md's "a wrong memory: forget"
      //   recovery is really for was the one case that could never work.
      // The rule below is derived from the target scope instead:
      //   thread → that thread, because the memory belongs to that conversation;
      //   agent  → a thread that agent owns, or its own minted thread;
      //   vault  → any thread, because the vault is shared and the user speaks
      //            for it wherever they speak.
      //
      // WHAT THIS GATE ACTUALLY PROVES, said plainly rather than overclaimed: the
      // user was PRESENT in a conversation this call can reach. It is not consent
      // to this particular revocation — any user_message will do, including
      // "thanks, that's helpful". That is a real reduction from "any tool call may
      // forget anything" and it is unforgeable from the agent surface, but closing
      // the rest needs the host to mark an event as a revocation REQUEST, which
      // the event schema cannot express today. Citing an event that is not the
      // user's grants nothing extra: citesUser tests the actor, and a failure just
      // leaves the ordinary agent-surface rule in force.
      //
      // Honest scope: no door in this repo can currently append a `user_message`
      // (append_event's event-type enum is derived from the actor table and
      // excludes every user-implied type, and events.ts refuses a `tool:`-sourced
      // one), so today no memory is user-stated and this argument changes no
      // outcome. It is the door the transport that DOES feed the event log will
      // need, and without it the authority rule is one nobody can ever satisfy.
      const cited = argStringList("authorizing_event_ids", a.authorizing_event_ids);
      let sourceEventIds: string[] | undefined;
      if (cited.length) {
        const citable =
          scope.scopeType === "vault"
            ? { sql: "TRUE", params: [] as unknown[] }
            : scope.scopeType === "thread"
              ? { sql: "e.thread_id = $2", params: [scope.scopeId] }
              : {
                  sql: "(t.agent_id = $2 OR e.thread_id = $3)",
                  params: [scope.scopeId, scopeThreadId(scope)],
                };
        const found = await c.db.query(
          `SELECT e.id FROM conversation_events e
             JOIN threads t ON t.id = e.thread_id
            WHERE e.id = ANY($1::text[]) AND ${citable.sql}`,
          [cited, ...citable.params],
        );
        if (found.rows.length !== cited.length) {
          throw new Error(
            "authorizing_event_ids must name events in a thread this call's scope can reach",
          );
        }
        sourceEventIds = found.rows.map((r) => String(r.id));
      }

      const targets: MemoryItem[] = [];
      for (const id of ids) {
        const m = await getMemory(c.db, id);
        // Out of scope reads as "no such memory": a caller must not learn that
        // another agent's memory exists, let alone revoke it.
        if (m && visibleIn(m, [scope])) targets.push(m);
      }
      if (targets.length === 0) {
        return { revoked: 0, memories: [], forgotten: false, reason: "not_found" };
      }

      const revoked: string[] = [];
      const projectionFailed: string[] = [];
      for (const target of targets) {
        const m = await revokeMemory(c.db, {
          memoryId: target.id,
          actor: "tool:forget",
          sourceEventIds,
          reason: argString("reason", a.reason) ?? undefined,
        });
        if (!m) continue;
        revoked.push(m.id);
        // Remove the projection now rather than waiting for the sweep: "forget"
        // must not leave the fact searchable. A failure here is NOT a successful
        // forget — the page is still live and findable — so report it instead of
        // dropping the result on the floor.
        const p = await projectMemory(c.db, c.store, m);
        if (p.status !== "removed") projectionFailed.push(m.id);
      }
      return {
        revoked: revoked.length,
        memories: revoked,
        // The counterpart of remember's `saved`: a revocation is only done when
        // the generated page is gone too. Calling it again retries the retraction.
        forgotten: revoked.length > 0 && projectionFailed.length === 0,
        projection_failed: projectionFailed,
      };
    },
  },

  inspect_memory: {
    access: "read",
    description:
      "Everything known about one memory: current value, type, scope, provenance (source events), " +
      "effective dates, revision history and projection status. Visible scopes are named exactly " +
      "as in remember and recall; a memory outside them reads as not_found.",
    inputSchema: obj({ memory_id: { type: "string" } }, ["memory_id"]),
    handler: async (c: BrainCtx, a, s) => {
      const id = argString("memory_id", a.memory_id) ?? "";
      const found = await inspectMemory(c.db, id);
      // A raw memory id is a scope-free handle, so an out-of-scope hit must be
      // indistinguishable from a miss: otherwise inspect_memory is a read of a
      // sibling thread's (or another agent's) memory.
      if (!found || !visibleIn(found.memory, s.readable)) {
        throw new Error(`not_found: memory ${id}`);
      }
      return {
        id: found.memory.id,
        value: found.memory.content,
        structured_value: found.memory.structured_value,
        type: found.memory.memory_type,
        scope: { type: found.memory.scope_type, id: found.memory.scope_id },
        memory_key: found.memory.memory_key,
        status: found.memory.status,
        confidence: found.memory.confidence,
        effective_from: found.memory.valid_from,
        effective_to: found.memory.valid_to,
        expires_at: found.memory.expires_at,
        supersedes_id: found.memory.supersedes_id,
        projection: {
          status: found.memory.projection_status,
          page_id: found.memory.projection_page_id,
        },
        provenance: found.sources,
        history: found.revisions,
      };
    },
  },

  append_event: {
    access: "write",
    description:
      "Append one immutable conversation event for what YOU did, in the scope you name (the same " +
      "fields remember takes; agent_id alone appends to your own scope's thread). Pass " +
      "idempotency_key so an at-least-once pipeline can retry safely — a replay returns the " +
      "existing event instead of duplicating it. Event types that speak for the user " +
      "(user_message, approval) are not offered: extraction treats the user's own words as " +
      "authority, so a tool cannot mint them. Never send hidden reasoning; secret text is " +
      "withheld from the log, not stored.",
    inputSchema: obj(
      {
        // Derived from the actor table rather than listed: a new event type is
        // callable here the day it is added ONLY if it does not speak for the
        // user, and no second list can drift out of step with that rule.
        event_type: { type: "string", enum: TOOL_APPENDABLE_EVENTS },
        content: { type: "string" },
        structured_payload: { type: "object" },
        actor_id: { type: "string" },
        // No `source`. It is the one field on the row that says where an event
        // really came from, so the TOOL sets it; a caller-chosen source is a
        // label the caller can lie with.
        trace_id: { type: "string" },
        idempotency_key: { type: "string" },
      },
      ["event_type"],
    ),
    handler: async (c: BrainCtx, a, s) => {
      await ensureThread(c.db, s.threadId, s.agentId ?? undefined);
      const res = await appendConversationEvent(c.db, {
        threadId: s.threadId,
        // argEnum, not argString: the schema declares this field's values, so the
        // reader has to be the one that checks them. Leaving it to events.ts meant a
        // prototype-unsafe `IMPLIED_ACTOR[eventType]` lookup decided membership, and
        // "constructor" / "toString" / "valueOf" / "__proto__" all passed it — they
        // were stopped only by the driver choking on a function-valued parameter,
        // which fails closed by accident and with a driver-specific message.
        eventType: argEnum("event_type", a.event_type, TOOL_APPENDABLE_EVENTS, "") as EventType,
        content: argString("content", a.content) ?? "",
        structuredPayload: (a.structured_payload as Record<string, unknown>) ?? {},
        actorId: argString("actor_id", a.actor_id) ?? undefined,
        source: "tool:append_event",
        traceId: argString("trace_id", a.trace_id) ?? undefined,
        idempotencyKey: argString("idempotency_key", a.idempotency_key) ?? undefined,
      });
      return {
        event_id: res.event.id,
        sequence: res.event.sequence,
        duplicate: res.duplicate,
      };
    },
  },

  list_events: {
    access: "read",
    description:
      "Read the events of the scope you name, in order, from an optional sequence exclusive. " +
      "The thread comes from the scope (the same fields remember takes), so an event is " +
      "reachable only by naming the scope it was written in — exactly like a memory.",
    inputSchema: obj({
      from_sequence: { type: "number" },
      limit: { type: "number" },
    }),
    handler: async (c: BrainCtx, a, s) => {
      const threadId = s.threadId;
      const thread = await getThread(c.db, threadId);
      if (!thread) throw new Error(`not_found: thread ${threadId}`);
      const events = await getConversationEvents(c.db, {
        threadId,
        fromSequence: a.from_sequence as number,
        limit: a.limit as number,
      });
      return { thread, events };
    },
  },

  refresh_summary: {
    access: "write",
    description:
      "Fold the events since the active summary's covered range into a new version, for the " +
      "scope you name. Returns unchanged=true when there is nothing new, rather than churning " +
      "a version.",
    inputSchema: obj({}),
    handler: async (c: BrainCtx, _a, s) => {
      const { summarizerFromEnv } = await import("./summarizer-default");
      const res = await refreshThreadSummary(c.db, summarizerFromEnv(), s.threadId);
      return {
        unchanged: res.unchanged,
        version: res.summary?.version ?? null,
        covered_from: res.summary?.covered_from_sequence ?? null,
        covered_through: res.summary?.covered_through_sequence ?? null,
        summary: res.summary?.structured_summary ?? null,
        rendered: res.summary?.rendered_summary ?? null,
      };
    },
  },

  get_summary: {
    access: "read",
    description:
      "The active summary of the scope you name, or its full version history with history=true " +
      "(every version is kept for debugging).",
    inputSchema: obj({ history: { type: "boolean" } }),
    handler: async (c: BrainCtx, a, s) => {
      const threadId = s.threadId;
      if (argBool("history", a.history))
        return { history: await getThreadSummaryHistory(c.db, threadId) };
      return { summary: await getActiveThreadSummary(c.db, threadId) };
    },
  },

  memory_gate: {
    access: "read",
    description:
      "Should durable memory be retrieved for this input? Deterministic — used to avoid a memory " +
      "lookup on every turn.",
    inputSchema: obj({ input: { type: "string" } }, ["input"]),
    // Takes no scope, and still goes through `scoped` — there is NO opt-out. A
    // tool that could skip the wrapper is a tool that could grow a data read
    // later and skip the parse with it.
    handler: async (_c: BrainCtx, a) => shouldRetrieveMemory(argString("input", a.input) ?? ""),
  },
};

// CONSTRUCTED, not written. Every entry passes through `scoped`, so there is no
// way to add a memory tool that publishes different scope fields or parses them
// its own way — the two divergences that produced write-only memory and the
// shared 'direct' thread.
export const MEMORY_TOOLS: Record<string, ToolDef> = Object.fromEntries(
  Object.entries(SCOPED_MEMORY_TOOLS).map(([name, def]) => [name, scoped(def)]),
);
