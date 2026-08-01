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
import { ensureThread } from "./events";
import { appendConversationEvent } from "./events";
import type { MemoryType, ScopeType } from "./items";
import { inspectMemory, revokeMemory, writeMemory } from "./items";
import { projectMemory } from "./projection";
import { recallMemory, searchMemoryByKey, shouldRetrieveMemory } from "./recall";

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  ...(required.length ? { required } : {}),
});

const SCOPE_ENUM = ["thread", "agent", "vault"];
const TYPE_ENUM = ["semantic", "preference", "episodic", "procedural", "working_state"];

function readScope(a: Record<string, unknown>): { scopeType: ScopeType; scopeId: string | null } {
  const requested = String(a.scope ?? a.scope_type ?? "agent");
  const scopeType = (SCOPE_ENUM.includes(requested) ? requested : "agent") as ScopeType;
  const raw = a.scope_id ?? a.agent_id ?? a.thread_id;
  const scopeId = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  if (scopeType !== "vault" && !scopeId) {
    // Refuse rather than fall back to something broader: a thread memory with no
    // thread is not a vault memory.
    throw new Error(`scope_id is required for scope '${scopeType}'`);
  }
  return { scopeType, scopeId };
}

// Scopes a caller may READ. Broader scopes are visible from a narrower request
// (a thread can see agent and vault facts) but never the reverse, and never a
// sibling's.
function readableScopes(
  a: Record<string, unknown>,
): { scopeType: ScopeType; scopeId: string | null }[] {
  const scopes: { scopeType: ScopeType; scopeId: string | null }[] = [
    { scopeType: "vault", scopeId: null },
  ];
  const agentId = typeof a.agent_id === "string" && a.agent_id.trim() ? a.agent_id.trim() : null;
  const threadId =
    typeof a.thread_id === "string" && a.thread_id.trim() ? a.thread_id.trim() : null;
  if (agentId) scopes.push({ scopeType: "agent", scopeId: agentId });
  if (threadId) scopes.push({ scopeType: "thread", scopeId: threadId });
  return scopes;
}

export const MEMORY_TOOLS: Record<string, ToolDef> = {
  remember: {
    access: "write",
    description:
      "Save one durable memory. The result says what actually happened: committed, candidate " +
      "(needs approval), conflict (contradicts an active memory), or rejected (e.g. contained a " +
      "credential) — a candidate is NOT saved as fact. Use memory_key for a value that can change " +
      "later (user.billing_email), so a correction supersedes it instead of duplicating it.",
    inputSchema: obj(
      {
        content: { type: "string" },
        memory_type: { type: "string", enum: TYPE_ENUM },
        scope: { type: "string", enum: SCOPE_ENUM },
        scope_id: { type: "string" },
        memory_key: { type: "string" },
        thread_id: {
          type: "string",
          description: "Thread this statement was made in, for provenance.",
        },
        structured_value: { type: "object" },
      },
      ["content"],
    ),
    handler: async (c: BrainCtx, a) => {
      const { scopeType, scopeId } = readScope(a);
      const content = String(a.content ?? "").trim();
      if (!content) throw new Error("content is required");

      // An explicit remember IS an observable user action, so it becomes an event
      // and the memory cites it. That is how a tool-created memory gets real
      // provenance instead of being a fact from nowhere.
      const threadId =
        typeof a.thread_id === "string" && a.thread_id.trim() ? a.thread_id.trim() : "direct";
      await ensureThread(c.db, threadId);
      const { event } = await appendConversationEvent(c.db, {
        threadId,
        eventType: "user_message",
        content,
        source: "tool:remember",
      });

      const res = await writeMemory(c.db, {
        scopeType,
        scopeId,
        memoryType: (TYPE_ENUM.includes(String(a.memory_type))
          ? a.memory_type
          : "semantic") as MemoryType,
        memoryKey:
          typeof a.memory_key === "string" && a.memory_key.trim() ? a.memory_key.trim() : null,
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
      "Revoke a memory by id, or by memory_key within a scope. It leaves active retrieval " +
      "immediately; the revision history is kept, and the generated page is cleaned up.",
    inputSchema: obj({
      memory_id: { type: "string" },
      memory_key: { type: "string" },
      scope: { type: "string", enum: SCOPE_ENUM },
      scope_id: { type: "string" },
      reason: { type: "string" },
    }),
    handler: async (c: BrainCtx, a) => {
      let ids: string[] = [];
      if (typeof a.memory_id === "string" && a.memory_id.trim()) {
        ids = [a.memory_id.trim()];
      } else if (typeof a.memory_key === "string" && a.memory_key.trim()) {
        const { scopeType, scopeId } = readScope(a);
        const found = await searchMemoryByKey(c.db, {
          memoryKey: a.memory_key.trim(),
          scopes: [{ scopeType, scopeId }],
        });
        ids = found.map((m) => m.id);
      } else {
        throw new Error("memory_id or memory_key is required");
      }
      if (ids.length === 0) return { revoked: 0, memories: [], reason: "not_found" };

      const revoked: string[] = [];
      for (const id of ids) {
        const m = await revokeMemory(c.db, {
          memoryId: id,
          actor: "tool:forget",
          reason: typeof a.reason === "string" ? a.reason : undefined,
        });
        if (!m) continue;
        revoked.push(m.id);
        // Remove the projection now rather than waiting for the sweep: "forget"
        // must not leave the fact searchable.
        await projectMemory(c.db, c.store, m);
      }
      return { revoked: revoked.length, memories: revoked };
    },
  },

  inspect_memory: {
    access: "read",
    description:
      "Everything known about one memory: current value, type, scope, provenance (source events), " +
      "effective dates, revision history and projection status.",
    inputSchema: obj({ memory_id: { type: "string" } }, ["memory_id"]),
    handler: async (c: BrainCtx, a) => {
      const found = await inspectMemory(c.db, String(a.memory_id ?? ""));
      if (!found) throw new Error(`not_found: memory ${String(a.memory_id ?? "")}`);
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

  memory_gate: {
    access: "read",
    description:
      "Should durable memory be retrieved for this input? Deterministic — used to avoid a memory " +
      "lookup on every turn.",
    inputSchema: obj({ input: { type: "string" } }, ["input"]),
    handler: async (_c: BrainCtx, a) => shouldRetrieveMemory(String(a.input ?? "")),
  },
};
