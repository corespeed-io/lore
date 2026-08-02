---
name: lore-brain
description: Read from and write to a Lore brain over its MCP endpoint — pick the right write door (put_page vs remember_note vs remember) and the right read door (search vs recall vs the graph). Use whenever saving something worth keeping, looking something up in the brain, or answering "what do we know about X". Triggers include "save this", "记一下", "remember that", "what do we know about", "look it up in the brain", "查一下 brain".
---

Lore serves a brain at `POST /api/mcp` (JSON-RPC 2.0, bearer `BRAIN_WRITE_TOKEN` for
writes, `BRAIN_READ_TOKEN` for reads). Twenty-four tools, nine of which write —
`put_page`, `delete_page`, `rename_page`, `restore_page`, `remember_note`, `remember`,
`forget`, `append_event`, `refresh_summary`.

**Picking the wrong door is the failure mode this skill exists to prevent.** Three of
those nine CREATE something new, and they are not variations on each other — they land
in different places with different guarantees.

## Writing

| Door | Use when | What you get |
|---|---|---|
| `put_page` | Durable knowledge you will come back to, link to, or edit again | A page at a slug **you choose**. `[[wikilinks]]` in the body become graph edges. Upsert — omitted fields keep their old values. |
| `remember_note` | One atomic thought, no slug worth deciding | A page auto-slugged `mem-<uuid>`. An exact repeat returns the existing page instead of a duplicate. |
| `remember` | A fact about the world that may later change or be contradicted | A **durable memory**, not a page — with provenance, scope, and supersession. Projects into `memory/`. |

Decision, in order:

1. Does it need a name you'd type again (`projects/lore`, `people/spenc`)? → `put_page`.
2. Is it a fact that could later be superseded ("prefers X", "the deploy target is Y")? → `remember`.
3. Otherwise → `remember_note`.

`remember` does not always commit. Read the result:

- `committed` — saved as fact.
- `candidate` — **not saved**; it needs approval. Say so rather than reporting success.
- `conflict` — contradicts an active memory. Resolve it, don't retry blindly.
- `rejected` — refused (e.g. it contained a credential). Do not work around this.

An unkeyed note commits because it displaces nothing; a keyed memory displaces its
predecessor, which is why it can conflict.

### Linking

There is no `add_link` tool. Edges come from `[[wikilinks]]` in a body, or
`frontmatter.related_ids`. To connect two existing pages, edit one's body — the
graph is a consequence of the prose, not a separate structure to maintain.

`put_page` returns `pending`: refs that matched no page. Correct them in the same
turn or leave them deliberately — a pending ref is how a page-to-be gets claimed.

## Reading

| Door | Searches | Notes |
|---|---|---|
| `search` | Pages | Hybrid: vector + FTS + trigram, rank-fused. `query` is a **literal alias** — no expansion, no rerank. |
| `recall` | Durable memories only | Scope-bound and server-decided. `as_of` for "what was it before it changed". `expand_graph` to pull in linked context. |
| `get_page` | One page | `fuzzy: true` falls back to title match. |
| `traverse_graph` / `get_backlinks` | Edges | Use when the question is about *connection*, not content. |

`search` will not find a durable memory's raw record and `recall` will not find a
page. When you don't know which holds the answer, run both — they are cheap and
they cover different stores.

Answering "what do we know about X" well means: `search` for the pages, `recall`
for the memories, then `get_backlinks` on whatever came back central. Three calls,
not one.

## Calling it

```bash
curl -s localhost:3000/api/mcp \
  -H "Authorization: Bearer $BRAIN_WRITE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"put_page","arguments":{"slug":"projects/lore","body":"…"}}}'
```

`tools/list` with a read token shows the 15 read tools; with a write token, all 24.
That difference is the security boundary, not a display quirk — never hand a write
token to something that only needs to read.

For the durable-memory model in depth — scopes, supersession, the event log — see
[[lore-memory]]. For graph hygiene, see [[lore-curate]].
