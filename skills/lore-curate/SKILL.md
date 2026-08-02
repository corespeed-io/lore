---
name: lore-curate
description: Keep a Lore brain healthy — find orphan pages and broken links, rename without breaking references, run the mention-linking and memory background jobs, import an Obsidian vault, export the whole brain. Use for periodic upkeep rather than per-write decisions. Triggers include "clean up the brain", "why is the graph empty", "broken links", "import my vault", "export the brain", "整理一下 brain", "图怎么是空的".
---

Upkeep, not per-write routing — for that see [[lore-brain]].

## The two ways a graph looks empty

Lore names them rather than showing a blank canvas:

- **`list_broken_links`** — refs pointing at pages that do not exist, as
  `{from_slug, ref}`. Either the target is worth creating, or the ref is a typo.
- **`find_orphans`** — pages nothing links to. Not a defect on its own; a brain with
  many is a brain nobody is connecting.

A broken link is a *promise* — someone wrote `[[thing]]` meaning it. Creating the
page is usually the right fix; deleting the ref is the exception.

## Renaming without breaking anything

`rename_page{slug, to}` changes the slug, and **the old slug becomes an alias** —
other pages' bodies are left untouched and their links keep resolving. You do not
need to rewrite referring pages, and you should not.

Closed at both ends: the `memory/` namespace cannot be moved out of, and nothing can
be moved into it. Those pages belong to their memories.

## Delete is soft

`delete_page` keeps the body and its links; `restore_page` brings it back and
re-indexes it. Neither works on a `memory/` projection — revoke the memory with
`forget` instead, which is scoped. See [[lore-memory]].

## The background jobs

`POST /api/maintenance` (bearer `BRAIN_WRITE_TOKEN`). **Nothing calls it on its own** —
it is off until you wire a scheduler (Workers Cron, Railway cron, a laptop crontab).

| Body | Job |
|---|---|
| `{}` | Mention sweep — deterministic linking into the `auto` edge lane |
| `{"limit": 50}` | Batch size (default 50, max 200) |
| `{"dryRun": true}` | Report the edges it *would* add, write none |
| `{"action": "clear"}` | Drop every auto edge and rescan later |
| `{"action": "memory"}` | Summarize, extract, project, consolidate |
| `{"action": "health"}` | Backend health counters, no writes |

Two lanes of edges: `declared` (a `[[wikilink]]` someone wrote) and `auto` (the
mention sweep inferred it). Only `declared` edges count toward search's backlink
boost — an inferred edge must not be able to promote a page.

Start with `dryRun` on an unfamiliar brain. The memory job is deliberately not run
after every message; a lease keeps exactly one writer at a time.

## Import and export

**Import** — the `/import` page in the browser: pick a folder of markdown, the
browser reads it and posts batches to `/api/import`. Files become pages, folders
become slug prefixes, `[[wikilinks]]` become edges. Nothing server-side touches a
filesystem.

Refusals are **per file**: one file carrying a credential comes back with its path
for you to redact, and the rest of the vault still imports. Import writes through
the same `put_page` door as everything else, so it crosses the same screens.

**Export** — `GET /api/export` returns a tar of `slug.md`. It needs the **write**
token, not the read token: a full dump bypasses the read-surface filter, so the
read credential is deliberately not enough for it.

## A reasonable pass

1. `list_broken_links` → create what was promised, fix the typos.
2. `find_orphans` → link them from somewhere real, or accept them.
3. `get_recent_salience` → what has been moving; is it linked in?
4. `POST /api/maintenance {"dryRun": true}` → see what the sweep would connect.
