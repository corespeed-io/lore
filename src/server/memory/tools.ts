// The agent-facing memory tools: remember, recall, forget, inspect_memory.
//
// Two rules shape these signatures:
//
//   The server decides scope and filters. A caller asks for "agent scope" and
//   names its agent; it cannot pass a database predicate, widen a scope, or
//   select rows the policy would exclude. Anything an LLM controls is a request,
//   not a query.
//
//   `remember` never says "saved" when it did not save. Its result distinguishes
//   committed / candidate / conflict / rejected, because an agent that believes a
//   candidate was committed will confidently tell the user something untrue.

import type { BrainCtx, ToolDef } from "../mcp";
import type { EventType } from "./events";
import { appendConversationEvent, ensureThread, getConversationEvents, getThread } from "./events";
import type { MemoryItem, MemoryType, ScopeType } from "./items";
import { getMemory, inspectMemory, revokeMemory, writeMemory } from "./items";
import { projectMemory } from "./projection";
import { recallMemory, searchMemoryByKey, shouldRetrieveMemory } from "./recall";
import { redactSecrets } from "./safety";
import { getActiveThreadSummary, getThreadSummaryHistory, refreshThreadSummary } from "./summary";

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  ...(required.length ? { required } : {}),
});

const SCOPE_ENUM = ["thread", "agent", "vault"];
const TYPE_ENUM = ["semantic", "preference", "episodic", "procedural", "working_state"];

type Scope = { scopeType: ScopeType; scopeId: string | null };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// The scope id is read from the field that NAMES that scope. Taking
// `scope_id ?? agent_id ?? thread_id` while the type defaulted to 'agent' let
// remember(thread_id) store an {agent, <thread id>} memory that
// recall(thread_id) — which looks under thread:<thread id> — could never find:
// write-only memory that reports saved:true. So the type picks the id, and an
// unnamed scope is inferred from the id the caller DID pass rather than assumed.
function readScope(a: Record<string, unknown>): Scope {
  const scopeIdArg = str(a.scope_id);
  const agentId = str(a.agent_id);
  const threadId = str(a.thread_id);
  const inferred = scopeIdArg || agentId ? "agent" : threadId ? "thread" : "agent";
  const requested = String(a.scope ?? a.scope_type ?? inferred);
  const scopeType = (SCOPE_ENUM.includes(requested) ? requested : "agent") as ScopeType;
  // Vault has exactly one instance, so it has no id. Carrying one would store a
  // scope_id that every reader looks for as '' and never matches.
  if (scopeType === "vault") return { scopeType, scopeId: null };
  const scopeId = scopeIdArg ?? (scopeType === "agent" ? agentId : threadId);
  if (!scopeId) {
    // Refuse rather than fall back to something broader: a thread memory with no
    // thread is not a vault memory.
    throw new Error(`scope_id is required for scope '${scopeType}'`);
  }
  return { scopeType, scopeId };
}

// Scopes a caller may READ. Broader scopes are visible from a narrower request
// (a thread can see agent and vault facts) but never the reverse, and never a
// sibling's.
function readableScopes(a: Record<string, unknown>): Scope[] {
  const scopes: Scope[] = [{ scopeType: "vault", scopeId: null }];
  const agentId = str(a.agent_id);
  const threadId = str(a.thread_id);
  if (agentId) scopes.push({ scopeType: "agent", scopeId: agentId });
  if (threadId) scopes.push({ scopeType: "thread", scopeId: threadId });
  return scopes;
}

// A memory is reachable only through a scope the caller named. A raw memory_id
// carries no scope at all, so without this check `forget(<id>)` and
// `inspect_memory(<id>)` reach another agent's or another thread's memory —
// exactly the widening an LLM must never be able to do.
function visibleIn(memory: MemoryItem, scopes: Scope[]): boolean {
  return scopes.some(
    (s) => s.scopeType === memory.scope_type && (s.scopeId ?? "") === (memory.scope_id ?? ""),
  );
}

export const MEMORY_TOOLS: Record<string, ToolDef> = {
  remember: {
    access: "write",
    description:
      "Save one durable memory. The result says what actually happened: committed, candidate " +
      "(needs approval), conflict (contradicts an active memory), or rejected (e.g. contained a " +
      "credential) — a candidate is NOT saved as fact. Use memory_key for a value that can change " +
      "later (user.billing_email), so a correction supersedes it instead of duplicating it. " +
      "Scope defaults to what you name: scope_id/agent_id means agent scope, thread_id alone " +
      "means thread scope — and recall with that same id reads it back.",
    inputSchema: obj(
      {
        content: { type: "string" },
        memory_type: { type: "string", enum: TYPE_ENUM },
        scope: { type: "string", enum: SCOPE_ENUM },
        scope_id: { type: "string" },
        memory_key: { type: "string" },
        thread_id: {
          type: "string",
          description:
            "Thread this statement was made in, for provenance. Also the scope id when no " +
            "scope_id/agent_id is given, so the memory is readable from this thread.",
        },
        structured_value: { type: "object" },
      },
      ["content"],
    ),
    handler: async (c: BrainCtx, a) => {
      const { scopeType, scopeId } = readScope(a);
      const content = String(a.content ?? "").trim();
      if (!content) throw new Error("content is required");

      // An explicit remember IS an observable action, so it becomes an event and
      // the memory cites it. That is how a tool-created memory gets real
      // provenance instead of being a fact from nowhere.
      //
      // It is an agent_action, NOT a user_message: only the user speaks for the
      // user (extract.ts trusts user_message as the one source that does), so an
      // agent able to mint user messages could forge a statement the next sweep
      // auto-commits at explicit:true over the real value.
      //
      // The content is redacted on the way in because conversation_events is
      // append-only BY DESIGN — there is no delete path — so a credential that
      // reaches it can never be removed, and it would flow on into summaries and
      // the context pack. The log still records that something was said. The RAW
      // text goes to writeMemory, which is the one gate that decides
      // committed/rejected, so a secret is refused there rather than laundered
      // into a memory reading "[redacted:…]".
      const threadId = str(a.thread_id) ?? "direct";
      await ensureThread(c.db, threadId);
      const { event } = await appendConversationEvent(c.db, {
        threadId,
        eventType: "agent_action",
        content: redactSecrets(content),
        source: "tool:remember",
      });

      const res = await writeMemory(c.db, {
        scopeType,
        scopeId,
        memoryType: (TYPE_ENUM.includes(String(a.memory_type))
          ? a.memory_type
          : "semantic") as MemoryType,
        memoryKey: str(a.memory_key),
        content,
        structuredValue: (a.structured_value as Record<string, unknown>) ?? {},
        sourceEventIds: [event.id],
        explicit: true,
        createdBy: "tool:remember",
      });
      // Project immediately so the memory is searchable in the same turn; a
      // failure here leaves the canonical record committed and reports honestly.
      let projection: string | null = null;
      if (res.memory && res.status === "committed") {
        const p = await projectMemory(c.db, c.store, res.memory);
        projection = p.status;
      }
      return {
        outcome: res.status,
        operation: res.operation,
        memory_id: res.memory?.id ?? null,
        // Deliberately explicit: "saved" is only true for committed.
        saved: res.status === "committed",
        superseded_id: res.superseded?.id ?? null,
        conflicts_with: res.conflictsWith?.id ?? null,
        projection,
        reason: res.reason,
      };
    },
  },

  recall: {
    access: "read",
    description:
      "Retrieve durable memories relevant to a query. Only ACTIVE memories are returned; pass " +
      "as_of (ISO timestamp) for historical lookup ('what was it before it changed'). Scope is " +
      "decided by the server from thread_id/agent_id — it cannot be widened by the caller.",
    inputSchema: obj(
      {
        query: { type: "string" },
        thread_id: { type: "string" },
        agent_id: { type: "string" },
        limit: { type: "number" },
        as_of: { type: "string", description: "ISO timestamp for historical recall." },
        expand_graph: { type: "boolean" },
        memory_type: { type: "string", enum: TYPE_ENUM },
      },
      ["query"],
    ),
    handler: async (c: BrainCtx, a) => {
      const asOf = typeof a.as_of === "string" && a.as_of.trim() ? a.as_of.trim() : undefined;
      const results = await recallMemory(c.db, c.store, {
        query: String(a.query ?? ""),
        scopes: readableScopes(a),
        limit: a.limit as number,
        asOf,
        expandGraph: Boolean(a.expand_graph),
        types: typeof a.memory_type === "string" ? [a.memory_type as MemoryType] : undefined,
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
      "Revoke a memory by id, or by memory_key, within the scope you name (scope + scope_id, or " +
      "agent_id/thread_id) — a memory outside that scope reads as not_found. It leaves active " +
      "retrieval immediately; the revision history is kept, and the generated page is cleaned up. " +
      "`forgotten` is true only when the page was retracted too.",
    inputSchema: obj({
      memory_id: { type: "string" },
      memory_key: { type: "string" },
      scope: { type: "string", enum: SCOPE_ENUM },
      scope_id: { type: "string" },
      agent_id: { type: "string" },
      thread_id: { type: "string" },
      reason: { type: "string" },
    }),
    handler: async (c: BrainCtx, a) => {
      // Every revocation names its scope, the memory_id path included: a bare id
      // is a scope-free handle, and this is the path that takes a fact away from
      // everyone else's retrieval.
      const scope = readScope(a);
      let ids: string[] = [];
      const memoryId = str(a.memory_id);
      const memoryKey = str(a.memory_key);
      if (memoryId) {
        ids = [memoryId];
      } else if (memoryKey) {
        const found = await searchMemoryByKey(c.db, { memoryKey, scopes: [scope] });
        ids = found.map((m) => m.id);
      } else {
        throw new Error("memory_id or memory_key is required");
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
          reason: str(a.reason) ?? undefined,
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
      "effective dates, revision history and projection status. Visible scopes come from " +
      "thread_id/agent_id exactly as in recall; a memory outside them reads as not_found.",
    inputSchema: obj(
      {
        memory_id: { type: "string" },
        thread_id: { type: "string" },
        agent_id: { type: "string" },
      },
      ["memory_id"],
    ),
    handler: async (c: BrainCtx, a) => {
      const id = String(a.memory_id ?? "");
      const found = await inspectMemory(c.db, id);
      // A raw memory id is a scope-free handle, so an out-of-scope hit must be
      // indistinguishable from a miss: otherwise inspect_memory is a read of a
      // sibling thread's (or another agent's) memory.
      if (!found || !visibleIn(found.memory, readableScopes(a))) {
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
      "Append one immutable conversation event. Pass idempotency_key so an at-least-once " +
      "pipeline can retry safely — a replay returns the existing event instead of duplicating it. " +
      "Never send hidden reasoning; redact secrets from tool payloads before calling.",
    inputSchema: obj(
      {
        thread_id: { type: "string" },
        event_type: {
          type: "string",
          enum: [
            "user_message",
            "assistant_message",
            "tool_call",
            "tool_result",
            "agent_action",
            "approval",
            "artifact",
            "system_observation",
          ],
        },
        content: { type: "string" },
        structured_payload: { type: "object" },
        actor_id: { type: "string" },
        source: { type: "string" },
        trace_id: { type: "string" },
        idempotency_key: { type: "string" },
        agent_id: { type: "string" },
      },
      ["thread_id", "event_type"],
    ),
    handler: async (c: BrainCtx, a) => {
      const threadId = String(a.thread_id ?? "").trim();
      if (!threadId) throw new Error("thread_id is required");
      await ensureThread(c.db, threadId, typeof a.agent_id === "string" ? a.agent_id : undefined);
      const res = await appendConversationEvent(c.db, {
        threadId,
        eventType: String(a.event_type) as EventType,
        content: typeof a.content === "string" ? a.content : "",
        structuredPayload: (a.structured_payload as Record<string, unknown>) ?? {},
        actorId: typeof a.actor_id === "string" ? a.actor_id : undefined,
        source: typeof a.source === "string" ? a.source : undefined,
        traceId: typeof a.trace_id === "string" ? a.trace_id : undefined,
        idempotencyKey: typeof a.idempotency_key === "string" ? a.idempotency_key : undefined,
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
    description: "Read a thread's events in order, from an optional sequence exclusive.",
    inputSchema: obj(
      {
        thread_id: { type: "string" },
        from_sequence: { type: "number" },
        limit: { type: "number" },
      },
      ["thread_id"],
    ),
    handler: async (c: BrainCtx, a) => {
      const threadId = String(a.thread_id ?? "");
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
      "Fold the events since the active summary's covered range into a new version. Returns " +
      "unchanged=true when there is nothing new, rather than churning a version.",
    inputSchema: obj({ thread_id: { type: "string" } }, ["thread_id"]),
    handler: async (c: BrainCtx, a) => {
      const { summarizerFromEnv } = await import("./summarizer-default");
      const res = await refreshThreadSummary(c.db, summarizerFromEnv(), String(a.thread_id ?? ""));
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
      "The active thread summary, or its full version history with history=true (every version " +
      "is kept for debugging).",
    inputSchema: obj({ thread_id: { type: "string" }, history: { type: "boolean" } }, [
      "thread_id",
    ]),
    handler: async (c: BrainCtx, a) => {
      const threadId = String(a.thread_id ?? "");
      if (a.history) return { history: await getThreadSummaryHistory(c.db, threadId) };
      return { summary: await getActiveThreadSummary(c.db, threadId) };
    },
  },

  memory_gate: {
    access: "read",
    description:
      "Should durable memory be retrieved for this input? Deterministic — used to avoid a memory " +
      "lookup on every turn.",
    inputSchema: obj({ input: { type: "string" } }, ["input"]),
    handler: async (_c: BrainCtx, a) => shouldRetrieveMemory(String(a.input ?? "")),
  },
};
