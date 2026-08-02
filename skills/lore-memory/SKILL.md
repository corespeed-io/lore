---
name: lore-memory
description: Lore's durable agent-memory model — scopes (thread/agent/vault), the five memory types, supersession instead of overwrite, historical recall with as_of, the immutable event log and thread summaries. Use when saving or retrieving facts that may change, when a memory turns out to be wrong, when asking "what did I believe before", or when wiring an agent's per-thread state. Triggers include "remember that", "forget that", "what did I know at the time", "记住", "记错了", "改一下之前记的".
---

Durable memories are **not pages**. A page is text at a slug you own; a memory is a
claim with provenance, a scope, and a history — it supersedes rather than overwrites,
so being wrong later never destroys what you believed earlier.

Tools: `remember` · `recall` · `forget` · `inspect_memory` · `memory_gate` ·
`append_event` · `list_events` · `get_summary` · `refresh_summary`.

## Scope — name it the same way every time

`scope` is one of **`thread`**, **`agent`**, **`vault`**, with `scope_id` naming the
instance. Convenience fields: `thread_id` (thread scope), `agent_id` (agent scope).
`scope_id` on its own means an **agent**.

The scope is **decided by the server and cannot be widened by the caller.** A memory
outside your visible scopes does not error — it reads as `not_found`. That is a
containment property, not a bug: you cannot probe for the existence of memories you
are not allowed to see.

> The trap this design was built against: saving with `scope_id` and then looking for
> it with `agent_id`. Same call in your head, different scope on the server. **Save
> and recall with the identical fields**, every time.

`vault` is shared with every thread and agent and must be named on its own — it is
not a default you fall into.

## The five types

`semantic` · `preference` · `episodic` · `procedural` · `working_state`

Pick by how it will be *used*, not what it is about. "Prefers TypeScript" is a
`preference` even though it is a fact about a person; "the migration ran on Tuesday"
is `episodic` even though it is about the system.

## Keys, and why they matter

- **Unkeyed** memory always commits. It displaces nothing, so nothing can object.
- **Keyed** (`memory_key`) memory displaces its predecessor under that key — which is
  what makes it able to `conflict`.

Use a key for anything with exactly one current answer ("current deploy target",
"preferred editor"). Use no key for observations that accumulate.

## Read the result of `remember`

`committed` · `candidate` · `conflict` · `rejected`

**`candidate` is not saved.** It needs approval. Reporting "saved" on a candidate is
the single most damaging mistake against this API — the user believes something is
recorded that isn't. Say what actually happened.

`rejected` means refused, e.g. the content carried a credential. Do not rephrase to
sneak it past.

## Being wrong later

`forget` revokes by `memory_id` or `memory_key`, within the named scope. It leaves
active retrieval immediately; the revision history is kept and the generated
`memory/` page is cleaned up. Check `forgotten` — it is true only when something was
actually revoked.

To correct rather than erase, `remember` again under the same `memory_key`. The old
value stays in history and `as_of` can still reach it.

`inspect_memory` gives the whole picture for one memory: current value, type, scope,
the source events behind it, effective dates, revision history, projection status.
Reach for it before arguing with a memory you did not write.

## Historical recall

`recall` returns **only active** memories. Pass `as_of` (ISO timestamp) to ask what
was true then — "what was the deploy target before we moved it". `expand_graph: true`
pulls linked context in alongside.

## The event log

`append_event` writes one immutable event for **what you did**. The actor is derived
from `event_type`, never claimed:

| event_type | actor |
|---|---|
| `assistant_message`, `tool_call`, `agent_action`, `artifact` | assistant |
| `tool_result` | tool |
| `system_observation` | system |

`user_message` and `approval` imply the **user** and are therefore **not appendable
by a tool**. An agent cannot manufacture the user's words or the user's consent. If
you need those recorded, the user's own turn records them.

Pass `idempotency_key` whenever the caller might retry — a replay returns the
existing event instead of duplicating it.

`list_events` reads a scope's events in order from an optional exclusive sequence.
Events are reachable only by naming the scope they were written in, exactly like
memories.

## Summaries

`get_summary` returns the active summary of a scope (`history: true` for every
version). `refresh_summary` folds events since the covered range into a new version
and returns `unchanged: true` when there is nothing new — so calling it on a quiet
thread costs a query, not a version.

## `memory_gate` first

`memory_gate` answers "should durable memory be retrieved for this input at all",
deterministically. Use it to avoid a `recall` on every turn. It is a cost control,
not a permission check.

See [[lore-brain]] for choosing between a memory and a page in the first place.
