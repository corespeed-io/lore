# AGENTS.md — Lore

Orientation for AI coding agents (Claude Code, Codex, Cursor, Gemini, Copilot, …)
working in this repo. **This file is the single source of truth.** `CLAUDE.md` is a
symlink to it and `.github/copilot-instructions.md` points to it — only ever edit
*this* file (no copies to drift). Codex, Cursor, and Gemini CLI read `AGENTS.md`
natively. (On a Windows checkout without symlink support, `CLAUDE.md` may clone as a
text stub — set `git config core.symlinks true`.)

## What this is

**Lore** is the product — a **unified gbrain console** (one shell, not a read-only viewer).
`gbrain` is the backend engine (hybrid retrieval: vector + BM25 + RRF + rerank + a typed-edge
graph). One sidebar mixes two kinds of surface:

- **Read surfaces** (always on, read-only, safe-by-default): Dashboard/overview, force-directed
  graph, Memories browse, hybrid search. They call only `READ_ONLY_TOOLS`. This is the full
  OSS default experience — no admin config required. (The old "Lore never writes" contract
  now scopes to *these* surfaces, not the whole app.)
- **Admin surfaces** (optional, OFF by default, fail-closed): Requests, Access
  (OAuth clients/API keys), Queue, Calibration — inspired by upstream gbrain's admin dashboard, and may perform
  write/admin actions. They appear in the nav and work ONLY when admin mode is configured
  (explicit env + admin credentials, server-gated behind a SEPARATE allowlist). Unconfigured ⇒
  the admin nav is hidden and every `/api/admin/*` route 403s. Calibration is a read-only
  profile/diagnostics view; regenerating a profile is still a host-side gbrain CLI action unless
  upstream adds a dedicated admin HTTP endpoint. See **Admin mode** under Security.

Branding split: the app is **Lore** (sidebar wordmark, `<title>` prefix). The brain
it views is named by `APP_TITLE` (hero title, e.g. "CoreSpeed Library") and described
by `APP_SUBTITLE` (hero subtitle). Both are per-deployment env, so the OSS default
stays generic — don't hardcode a brand into components.

## Stack

- Next.js 15 (App Router) · React 19 · TypeScript
- d3 (graph viz only — **no chart library**; the dashboard chart is hand-rolled SVG)
- jose (Cloudflare Access JWT verification) · Biome (lint + format) · Vitest (tests)
- Design system: Vercel/Geist — near-white `#fafafa` canvas, near-black `#171717`
  ink, `#ebebeb` hairlines, Geist Sans/Mono, mono uppercase eyebrows, flat 12px
  cards / 6px controls, the mesh gradient confined to the hero. Keep to it.

## Run / test loop

```bash
npm run dev        # localhost:3000
npm run typecheck  # tsc --noEmit
npm run lint       # biome check .
npm run format     # biome check --write .
npm test           # vitest run
npm run build      # next build (production)
```

Required env (see `.env.example`): either `DATABASE_URL` (standalone brain, below)
or `GBRAIN_MCP_URL` + `GBRAIN_TOKEN` (remote gbrain). **Auth fails closed**, so for
local dev without Cloudflare Access set `AUTH_MODE=none` **and** `ALLOW_INSECURE=1`
— otherwise every route returns 403. Before opening a PR, all of
typecheck + lint + test + build must pass (this is what CI runs).

**GOTCHA — do not run `npm run build` while `npm run dev` is running.** They share
`.next/` and the build clobbers the dev webpack manifest → dev serves a blank page
(`__webpack_modules__[moduleId] is not a function`). To build: stop dev, `rm -rf
.next`, build, then `rm -rf .next` and restart dev.

## Standalone brain (no gbrain)

Setting `DATABASE_URL` (Postgres + pgvector, e.g. Neon) with `GBRAIN_MCP_URL`
unset flips lore into **standalone mode**: it serves its own single-tenant brain
instead of proxying a gbrain. `src/lib/gbrain.ts` `isStandalone()` short-circuits
`callTool` into `src/server/local.ts`, so every existing read path (dashboard,
graph, search, page view) works unchanged.

- `src/server/db.ts` — driver-free `Db` seam (`query` + `tx`) plus `initSchema`:
  pages / chunks / edges / pending_links / meta over pgvector + pg_trgm. The
  `meta` row pins the embedding space — **changing `EMBEDDINGS_MODEL`/`_DIM`
  fails loud** (re-embed required); never weaken that assert.
- `src/server/pipeline.ts` — chunking, `[[wikilink]]` extraction (fences
  stripped), OpenAI-compatible embeddings client (`EMBEDDINGS_URL/_API_KEY/
  _MODEL/_DIM`).
- `src/server/store.ts` — the engine. Writes embed BEFORE the transaction (no
  half-written pages); `content_hash` short-circuit makes re-ingest free;
  deletes are soft (`deleted_at`); unresolved wikilinks park in `pending_links`
  and resolve transactionally when the target page appears. Search = vector +
  FTS + trigram/ILIKE (the CJK arm — 'simple' tsvector can't segment CJK) fused
  with RRF; the vector arm degrades away if the embeddings call fails.
- Agent-facing write semantics: `put_page` is the only edit path, so **omitted
  fields are preserved** (kind, frontmatter) rather than reset — otherwise
  editing a memory's body demotes it to a note and drops its category and
  `related_ids`, which are graph edges. `frontmatter: {}` clears deliberately.
  `list_pages` takes `kind` (`memory` | `note`) so a client can list memories
  without pulling every page. There is deliberately no bulk-wipe tool: a
  client loop over `delete_page` covers it, and an unrecoverable mass delete
  on an agent-callable surface is a worse default than the tedium.
- Delete/restore invariant: `delete_page` sets `deleted_at` AND drops the
  page's chunks — the vector arm's inner query must stay a bare
  `ORDER BY … LIMIT` to keep HNSW, so its candidates are filtered by
  `deleted_at` only AFTER the LIMIT, and dead chunks would permanently steal
  ANN slots. `restore_page` therefore has to re-embed, and it **clears
  `content_hash` first**: without that the re-put matches the stored hash,
  short-circuits as "unchanged", reports success, and leaves a live page with
  zero chunks that the vector arm can never see again. Both halves are
  reverse-verified in `tests/brain-store.test.ts`.
- `remember` de-duplicates an exact repeat (same body + same frontmatter)
  instead of minting a second `mem-<uuid>`; an MCP retry is the ordinary case
  and `content_hash` cannot reconcile two different slugs.
- Link resolution has **four arms, in precedence order**: exact slug, exact
  title, filename (`pages.basename`), declared alias
  (`frontmatter->'aliases'`). Every comparison goes through `normalizeRef`
  (NFKC + lowercase + quote-strip + whitespace-collapse) and the basename arm
  additionally through `normalizeSlugish` (folds `-`/`_` to spaces).
  **`pages.basename`'s SQL expression and `normalizeSlugish` are two halves of
  one comparison — change one and you must change the other**, or the arm
  silently matches nothing (that shipped once and only a reverse-verified test
  caught it). `extractRefs` reads wikilinks AND Markdown links from the body
  AND from frontmatter string values, masks fenced *and* inline code, and skips
  `!` embeds. The forward-reference query in `putPage` must mirror all four
  arms or refs parked before their target existed never land.
- `put_page` returns `pending[]`: the refs that resolved to nothing, so an
  agent can correct a typo in the same turn. `find_orphans` (pages nothing
  points to) and `list_broken_links` are the human-facing halves.
- `rename_page` changes the slug in place and appends the old slug to that
  page's own aliases, which is what keeps stale `[[old-slug]]` refs elsewhere
  resolving. It deliberately does **not** rewrite other pages' bodies —
  that would mutate notes the user didn't touch, change their content_hash,
  and re-embed every referrer.
- Schema is at **v4**. The memory tables are declared in
  `src/server/memory/ddl.ts` and spliced into the ONE ddl list in `db.ts`; the
  v3→v4 step is additive (no existing table changes shape), so the same
  statements serve a fresh database and an upgrade. `tests/brain-migrate.test.ts`
  covers v1→current, v3→v4 with pages/edges/lanes/aliases/FTS intact, and a fresh
  database having every column its version claims.
- **Schema changes need a migration, not just DDL.** `CREATE TABLE IF NOT
  EXISTS` cannot alter an existing table, so `db.ts` keys explicit steps on
  `meta.schema_version` and — critically — runs them **before** the DDL block,
  because that DDL indexes columns (`basename`) an older database does not have
  yet. Get the order wrong and init throws `column "basename" does not exist`,
  which surfaces as an `isError` tool result and an empty dashboard, not a
  crash. `tests/brain-migrate.test.ts` builds a real v1 database and pins both
  the upgrade and the ordering.
- `src/server/mcp.ts` — one tool registry drives `tools/list` + `tools/call`:
  the 8 bare-name read tools lore calls (get_page errors MUST keep the literal
  `not_found` — lore regex-matches it; `traverse_graph` MUST return
  `{from_slug,to_slug}` rows) plus write tools `put_page` / `remember` /
  `delete_page` for agents.
- `src/app/api/mcp/route.ts` — stateless Streamable-HTTP MCP endpoint for
  agents. Its own bearer auth: `BRAIN_WRITE_TOKEN` (read+write) /
  `BRAIN_READ_TOKEN` (read-only), both ≥16 chars, fail-closed when unset;
  middleware exempts `/api/mcp` from viewer auth for exactly this reason —
  don't remove either side of that pairing.
- Tests: `tests/brain-store.test.ts` (PGlite + pgvector + pg_trgm, pinned
  `@electric-sql/pglite@0.4.3` — 0.5 dropped the bundled vector extension),
  `tests/brain-mcp.test.ts` (envelope/contract), `tests/brain-route.test.ts`
  (auth). The store is exercised against real SQL in-process; production picks
  a driver via `src/server/drivers.ts` (below).

## Vault import / export

- **Import** is browser-driven: `/import` (a client component) reads the folder
  with a plain directory input and POSTs batches to `/api/import`. Nothing
  server-side touches a filesystem, so it behaves identically on Node and
  Workers. `src/server/vault.ts` is the pure half — `pathToSlug`
  ("Projects/My Note.md" -> "projects/my-note", which the basename arm then
  matches against `[[My Note]]`), and a ~40-line frontmatter reader covering
  the subset Obsidian writes (scalars, inline and block arrays). It is
  deliberately NOT a YAML implementation; an unparseable value is kept as its
  raw string rather than dropped.
- **Export** is `/api/export`: a streamed USTAR tar of `slug.md`, one
  cursor-paged batch at a time so memory stays flat. `src/server/tar.ts` is
  ~130 lines and zero dependencies. Two things it gets right that are easy to
  break: the checksum field is **six octal digits + NUL + space** (not the
  plain octal form the numeric fields use — `tar` validates this exactly), and
  a path too long for USTAR's name(100)+prefix(155) is **skipped and reported**
  rather than truncated. Validated by extracting with the system `tar`.
- Both routes plus `/api/mcp` authenticate with the SAME bearer pair via
  `src/server/auth-bearer.ts` — one rule, one place. Import needs
  `BRAIN_WRITE_TOKEN`; export accepts either token. They are exempt from the
  viewer gate in `src/middleware.ts` (they are not browser users) but are still
  rate-limited there. **The viewer console stays read-only by construction:
  writing needs the write credential, whoever you are.**

## Ranking

`search` fuses three arms with flat RRF, then applies exactly two boosts
**before** the slice (after it they would only reorder what the caller already
got):

- **Title phrase** (x1.25, `src/server/title-match.ts`) — the query names this
  page. The load-bearing rules are STRUCTURAL, not tuned: token-boundary
  matching so "art" cannot match "Bartholomew", and a two-content-token floor
  so a query of "the" cannot promote everything. That is why this is safe to
  keep without a per-deployment eval — a wrong boundary rule fails visibly at
  rank 1, unlike a wrong weight.
- **Inbound links**, log-compressed (`1 + 0.05*ln(1+n)`) — in a hand-made link
  graph, how many notes point at a page is a direct read of what its author
  treats as central. **Only the `declared` lane counts**: an inferred edge must
  never be able to promote a page, and there is a test for that.

Both landed only after the eval fixture existed, and their effect is recorded
in it. There is deliberately no reranker, no query expansion, no similarity
floor and no autocut.

## Background job: mention linking

`src/server/mentions.ts` + `POST /api/maintenance` — the one enrichment worth
porting from gbrain's ~20-phase cycle, and the only occupant of the `auto` edge
lane. Deterministic, zero-LLM, and reversible: it writes only
`lane='auto', kind='mention'`, so `{"action":"clear"}` (or
`DELETE FROM edges WHERE lane='auto'`) undoes every inference it ever made.

Four choices carry the safety, none of them a tuned weight: the gazetteer is
built only from slug-prefixed typed pages (`people/ companies/ entities/
concepts/`) so a page called "Notes" cannot link from everywhere; a
`MIN_NAME_LENGTH` of 4 (short names under-link, which is the right trade — a
false auto edge pollutes the graph until someone notices, a missing one is
invisible); longest-match-wins so "Robert Smith" does not also link "Robert";
and code is masked exactly as it is for declared links, so a note documenting
`` `[[Name]]` `` syntax grows nothing.

Nothing calls the route on its own — wire whatever scheduler the host has, and
it is off until you do. It takes a compare-and-set lease on `meta` so two
schedulers cannot sweep at once, does at most 200 pages per call, and
`{"dryRun":true}` reports what it *would* link. An HTTP route rather than a
Workers `scheduled` handler on purpose: OpenNext's worker exports only `fetch`
plus its DO classes, and a Cron Trigger invocation caps at 15 minutes
wall-clock while an HTTP-triggered Worker does not.

## Agent Memory

Four layers in `src/server/memory/`, and the BOUNDARIES are the design. Postgres
is canonical for all four; `pages`/`edges`/FTS are a rebuildable projection, never
the only copy of anything.

| layer | table | rule |
|---|---|---|
| 1 events | `conversation_events` | immutable, ordered ground truth |
| 2 summary | `thread_summaries` | versioned rolling STATE, reproducible from (1) |
| 3 memory | `memory_items` + `memory_sources` + `memory_revisions` | canonical, typed, provenance-backed |
| 4 projection | `pages` under `memory/…` | derived, rebuildable, disposable |

**Events** (`events.ts`). Append-only: a correction is a NEW event, because
anything citing event 7 must always be able to read the event 7 it was built
from. `sequence` is allocated by bumping the counter on the thread row inside the
same transaction as the insert — that is what makes ordering deterministic under
concurrent appends and stops two replays of an `idempotency_key` from both
passing the duplicate check. Never store hidden chain-of-thought; redact secrets
from tool payloads before appending.

**Summaries** (`summary.ts`). Version N+1 = version N folded with the events after
its covered range; a partial unique index enforces exactly one active summary per
thread, which is why the old version is retired BEFORE the new one is inserted.
The summarizer is an interface (`summarizer-default.ts` ships an extractive,
model-free one); tests use `tests/helpers/fake-summarizer.ts`. A summary records
what was SAID, so it can legitimately contain a value durable memory has since
superseded — hence `SUMMARY_NOTE` labels it and memory comes later in the pack.

**Canonical memory** (`items.ts`). A committed memory is NEVER overwritten.
`writeMemory` picks the operation: ADD / NOOP / ENRICH / SUPERSEDE / CONFLICT.
**SUPERSEDE order is load-bearing** — retire the old row, then insert the
replacement, both in one transaction: the active-key partial unique index allows
one committed row per (scope, type, key), and inserting first fails. A
`fingerprint` over (scope, type, key, normalized content, source event range)
makes re-running extraction a NOOP. Provenance is mandatory: with no source event
a memory can only be a `candidate`. CONFLICT is recorded, never auto-resolved —
if two sources disagree and neither outranks the other, a machine picking a winner
is how a wrong fact becomes permanent.

**Safety** (`safety.ts`) is one gate every write passes. Secrets are REJECTED.
Instruction-shaped content is DEMOTED, not deleted: it stays searchable content,
can never become a procedure, and never auto-commits. A memory cannot widen
authorization — structurally, because no memory type is consulted for tool
permissions.

**Projection** (`projection.ts`). Stable slug per memory
(`memory/{thread|agent}/<scope>/<id>`, `memory/vault/<id>`), so a retry updates
instead of duplicating. Retired memories have their page soft-deleted, so a
superseded value leaves active search at once. A projection failure leaves the
memory `committed` with `projection_status='failed'` — canonical truth does not
depend on a page. **The `memory/` namespace is reserved and BOTH user write paths
refuse it** (`put_page` and `/api/import`) — guarding one and not the other is how
a generated page gets clobbered, and that shipped once before a test caught it.

**Retrieval** (`recall.ts`). Reuses the whole existing pipeline, then resolves
every hit back to canonical memory and filters on status, scope and time. Two
rules: a result appears only if its canonical row is still `committed`, and scope
is NEVER widened because a `scope_id` is missing. **Historical (`as_of`) recall
queries `memory_items` directly rather than through the projection** — retiring a
memory removes its page, so a superseded row has nothing left to search; this also
makes historical recall work when a projection has failed. The gate
(`shouldRetrieveMemory`) is deterministic and keeps durable memory out of turns
that do not need it.

**Context** (`context.ts`). Fixed order — system, role, working state, summary,
memory, uncovered recent events, user input, tool output — because order encodes
precedence. `MEMORY_GUARD` sits with the memory block every time. Ranking prefers
explicit over inferred and narrow scope over broad, deliberately NOT recency-first:
a stable fact does not become truer by being restated.

**Tools**: `remember` / `recall` / `forget` / `inspect_memory`, plus
`append_event` / `list_events` / `refresh_summary` / `get_summary` /
`memory_gate`. `remember` returns `committed|candidate|conflict|rejected` and an
explicit `saved` flag — reporting "saved" for a candidate is how an agent
confidently tells a user something untrue. It appends its own provenance event
rather than creating a fact from nowhere. The server decides scope; a caller
cannot pass a predicate or widen scope.

**Episodes and procedures** (`episodes.ts`). An episode stores observable
goal/actions/tools/result and CITES the event range instead of copying the trace.
A procedure needs two successful episodes, or one plus explicit approval, and
records required permissions as information only.

**Background work** (`maintenance.ts`, `consolidate.ts`) runs from
`POST /api/maintenance {"action":"memory"}` under the SAME lease as the mention
sweep: summarize → extract → project → consolidate, all bounded and idempotent.
Extraction is deliberately NOT synchronous per message. `{"action":"health"}`
returns the backend counters (unprocessed events, stale summaries, candidates,
conflicts, failed projections, stale active projections, lease state).

### Recovery

- **Rebuild every projection**: `UPDATE memory_items SET projection_status='pending'`,
  then `POST /api/maintenance {"action":"memory"}` until `projected` is 0. Pages
  are derived; this is always safe.
- **A failed projection**: canonical memory is fine. Find them with
  `{"action":"health"}` → `failed_projections`; the same maintenance call retries.
- **A wrong memory**: `forget` (revoke) — it leaves retrieval immediately and the
  revision history is kept. Never DELETE a row; the history is the audit trail.
- **Re-derive memory from events**: reset `extraction_checkpoints.last_extracted_sequence`
  to 0 and re-run. Fingerprints make it a NOOP rather than a duplication.
- **A stale page that outlived its memory** is counted as
  `stale_active_projections`; it should always be 0 after a maintenance pass.

## Agent Memory evaluation gate

`tests/memory-eval.test.ts` compares five context strategies over one frozen
multi-turn scenario, so each layer's value is a number:

| strategy | fact_recall@8 | temporal | supersession | stale-hit | distractor | ctx chars |
|---|---|---|---|---|---|---|
| A recent events | 0.875 | 1 | 0 | 0.667 | 0 | 204 |
| B summary only | 0.375 | 1 | 0 | 0.333 | 0 | 157 |
| C page search | 0.875 | 0 | 1 | 0.667 | 1 | 1865 |
| **D summary+memory** | **1.0** | **1** | **1** | **0** | **0** | 194 |
| **E D+graph** | **1.0** | **1** | **1** | **0** | **0** | 194 |

Recorded 2026-07-31. The finding worth keeping: **page search alone leaks stale
values (0.667) and has zero temporal accuracy** — which is why canonical filtering
is not optional. The gate asserts the CORRECTNESS metrics (supersession,
staleness, temporal), not taste: a ranking idea that improves recall while letting
a superseded value through is not an improvement. Embeddings, rerankers, autocut
and similarity floors stay gated behind this fixture plus the retrieval one.

## Retrieval regression gate

`tests/retrieval-eval.test.ts` + `tests/fixtures/retrieval.json` + the pure
metrics in `tests/metrics.ts` — a frozen 20-query corpus with relevance
judgments. (The metrics live outside the test file because biome forbids
exports from one; note also that a check run as `npm run lint | tail -1`
reports the PIPE's exit status, so it can never fail — do not gate on piped
commands.)
**Nothing that multiplies, floors, or truncates a score may ship without moving
these numbers first**: no title boost, no backlink boost, no similarity floor,
no autocut, no reranker. Baselines are recorded in the file as
history: `recall@10 0.9417 · ndcg@10 0.9291 · mrr 0.9667` for the bare arms,
then `0.9417 / 0.9357 / 0.9750` once the two ranking boosts landed — recall
held while ranking improved, which is exactly what a reordering boost should
do. The floors sit just under those and are printed
on every run, so a CI output diff is the signal. **Raise them when retrieval
genuinely improves; never lower them to make a build pass.**

Scope, stated honestly: the test embeds with a char-hash, so the vector arm
carries no meaning here — these numbers score the LEXICAL arms and the fusion
around them. That is the part a refactor breaks silently (verified: disabling
the trigram arm drops recall to 0.79 and fails the gate), but it is not a
quality claim against a real embedding model.

## Deploy targets

Lore deploys to Node hosts and Cloudflare Workers from the same tree with ONE
DB driver (node-postgres); the only infra-aware code is
`src/server/drivers.ts` (connection lifetime + where the URL comes from) —
keep it that way.

- **Local / Docker / Railway / Vercel** (Node): `next start` or the Dockerfile
  (Railway auto-detects; `railway.toml` present). Long-lived `pg` Pool over
  `DATABASE_URL`.
- **Cloudflare Workers** (OpenNext): `npm run cf:build` / `cf:preview` (local
  workerd) / `cf:deploy`. Config: `wrangler.jsonc` (nodejs_compat) +
  `open-next.config.ts`; build output `.open-next/` is gitignored AND
  biome-ignored (biome hangs crawling it). workerd forbids holding sockets
  across requests, so on Workers every query/tx opens a short-lived `pg`
  Client — cheap ONLY through the **Hyperdrive binding** (`HYPERDRIVE`, the
  blessed path: `wrangler hyperdrive create --caching-disabled`, works with
  any Postgres; a plain `DATABASE_URL` secret works but pays origin TLS per
  query). **`--caching-disabled` is mandatory** - Hyperdrive caches reads for
  60s and never invalidates them on write, so a put_page followed by a
  get_page returns the pre-write row (or `not_found`). Only the pooling is
  wanted here; this failure is Workers-only, Node and Railway never see it.
  The
  binding is read via `getCloudflareContext()` at runtime — it never appears
  in `process.env`, which is why standalone detection goes through
  `resolveDatabaseUrl()`, not an env check. Other secrets via
  `wrangler secret put` (EMBEDDINGS_API_KEY, BRAIN_*_TOKEN, UI_PASSWORD).
- The per-isolate in-memory rate limiter and the 1h graph cache are
  per-instance on Workers — acceptable, documented in `src/middleware.ts` /
  `src/lib/graph.ts`.
- After touching middleware or auth, smoke BOTH runtimes: `next start` and
  `cf:preview`, expecting `/` → 403 with no env, `/api/health` → 200.

## Architecture

- `src/components/App.tsx` — root state machine. One `tab` (`overview` | `graph` |
  `search`) plus a single `openPage` overlay. Opening a memory from ANYWHERE
  (dashboard panels, Memories list, graph nodes, wikilinks) calls `openMemory(slug)`
  → resolves via gbrain → sets `openPage`. The page overlays the current tab; the
  back-button label is `TAB_LABELS[tab]` and back just clears `openPage`. Opening a
  page never switches tabs, so `tab` IS the origin. Don't reintroduce per-tab page state.
- `src/app/api/graph/route.ts` + `src/lib/graph.ts` — `/api/graph` seeds a page
  set from `list_pages` plus the seed queries, then reads gbrain's **actual link graph**
  via a FEW deep `traverse_graph(direction=both)` calls from the most-relevant roots
  (`TRAVERSE_ROOTS`, `TRAVERSE_DEPTH`) — one bulk call returns a whole reachable
  neighborhood, so this covers the graph while keeping the gbrain request log quiet
  (the old `get_links`+`get_backlinks`-per-seed fan-out spammed it). `{nodes, links}`,
  **1h cached**. Edges come from gbrain's typed/mentions/manual links — **not** a regex
  over the search snippet, which missed every link outside the matched chunk. **Drops
  hash-titled mem0 imports** (`isHashTitle`) but keeps legitimate isolated pages so the
  graph shows pages that currently have no edges. Failure handling: every upstream
  read — seed queries, `list_pages`, traversals, including MCP `isError` results and
  non-edge-shaped payloads — feeds ONE failure signal. Zero fetched edges + any failed
  read ⇒ buildGraph **fails loud** (throws → route 502, logged, uncached) instead of
  caching an edgeless "everything scattered" (or empty) graph for the 1h TTL; edges
  survived + a failed read ⇒ served but NOT cached (next request retries); rebuilds are
  **single-flighted**, and a failed rebuild serves the last good expired graph **stale**
  rather than the 502. The dashboard renders the link stat as "—" (not 0) when the
  graph read failed. Slug == node id. Node `type` is dynamic: preserve gbrain's returned `type` string
  and only infer `person` / `company` / `product` from slug prefixes when the backend
  did not return a type.
- `src/app/api/call/route.ts` + `src/lib/gbrain.ts` — `/api/call` proxies a gbrain
  MCP tool, gated by `READ_ONLY_TOOLS` (the security boundary — see Security). It
  validates `tool` is a string and clamps unbounded args (`limit`/`depth`/…). Client
  calls go through `src/lib/api.ts` `apiCall(tool, args)`. **To use a new gbrain tool
  client-side, add it to `READ_ONLY_TOOLS` first** — and only if it's read-only.
- `src/lib/viz/graph.ts` — d3 force graph. Exposes `mountGraph(el, data, opts)` →
  `{ destroy, highlight(idSet|null) }`. Zoom/pan (wheel + bg-drag), free node drag,
  auto-fit on settle (~70 ticks) + dbl-click to fit.
- Components: `Sidebar` (nav + omnibox), `Overview` (dashboard), `ActivityChart`
  (per-day activity **bars**, hand-rolled SVG, pure `dailyCounts()`), `Breakdown`,
  `TopHubs`, `Sources`, `RecentActivity`, `GraphView`, `SearchResults` (Memories
  browse + type chips + ranked search), `PageView` (the memory page).

## gbrain constraints (read-only token, no admin scope)

- `get_stats` / `get_health` / `get_status_snapshot` need **admin** scope → 403.
  Don't build on them. Dashboard counts derive from `/api/graph` + `list_pages`.
- `list_pages` returns `{slug, title, type, updated_at}` — **no per-page source_id**,
  so you can't filter the Memories list by source. The public MCP operation also caps at
  100 and does not expose `offset`; don't call the browse list "complete" unless gbrain
  exposes real pagination first.
- Search uses gbrain `search` (ranked chunks: `score`, `evidence`, `chunk_text`).
  `query` adds LLM multi-query expansion (slower) — `search` is right for as-you-type.

## Security (it's a public repo serving a private brain — read this)

- **Two server boundaries**, each enforced before the upstream call:
  - **Viewer:** `READ_ONLY_TOOLS` in `src/lib/gbrain.ts` — the read-only allowlist.
    Never add a mutating tool to it; the viewer can call nothing else.
  - **Admin:** `ADMIN_ENDPOINTS` in `src/lib/admin.ts` — a SEPARATE explicit allowlist of
    upstream gbrain `/admin/api/*` endpoints. Keep the two lists separate; never merge
    admin endpoints into `READ_ONLY_TOOLS`.
- **Admin mode is off + fail-closed by default.** `/api/admin/*` routes 403 unless
  `adminEnabled(cfg)` holds: `ADMIN_MODE=1` **and** `ADMIN_GBRAIN_URL` **and**
  `ADMIN_GBRAIN_TOKEN` are set — **and**, when `AUTH_MODE=none`, also `ADMIN_ALLOW_INSECURE=1`
  (admin needs its own insecure opt-in even if the viewer is open locally). `/api/admin/status`
  returns only `{enabled}` (no secrets) so the client can decide whether to show the Admin area.
- **Credentials are server-only.** Read creds (`GBRAIN_TOKEN` / `GBRAIN_CLIENT_*`) live in
  `gbrain.ts`; the admin bootstrap token (`ADMIN_GBRAIN_TOKEN`) lives in `admin.ts`. Both
  guarded by `import "server-only"`. Never expose either to the client, never `NEXT_PUBLIC_*`,
  never commit `.env`. Admin responses pass through `stripSecrets` so token/secret/`client_secret`
  fields never reach the browser — except a create's **one-time** secret, which surfaces once and
  the UI masks + treats as one-time sensitive output.
- **Auth** lives in `src/middleware.ts` → `src/lib/auth.ts`. **GOTCHA: the middleware
  file MUST stay under `src/`** — this project keeps code in `src/`, and Next.js
  silently ignores a root-level `middleware.ts` in that layout (it shipped fail-OPEN
  that way once: empty middleware-manifest, no 403s, no rate limits — verify with
  `python3 -c "import json; print(json.load(open('.next/server/middleware-manifest.json'))['middleware'])"`
  after a build if you touch it). `AUTH_MODE=proxy` verifies
  the Cloudflare Access JWT with jose (signature against the team JWKS, `aud` ==
  `ACCESS_AUD`, issuer == team domain, exp). `password` = HTTP Basic. `none` denies
  unless `ALLOW_INSECURE=1`. A proxy deploy missing `ACCESS_AUD`/`ACCESS_TEAM_DOMAIN`
  fails closed. `/api/health` is the only auth-exempt route (for the platform healthcheck).
- `/api/call` and `/api/graph` are rate-limited per user in middleware; `next.config.mjs`
  sets a strict CSP + security headers (`'unsafe-eval'` is dev-only).

## Test gotchas (when verifying in a browser)

- Setting an input's `.value` + dispatching `input` does NOT trigger React 19's
  `onChange`. Use real keystrokes or the native value-setter.
- d3 click handlers need a real `MouseEvent` dispatched on the node (target by
  `circle.__data__.id`).
- Date strings are UTC (`updated_at`); render labels with `timeZone: "UTC"`.
- The dashboard renders all-zero until the client fetches gbrain (~1-2s); that's the
  load state, not a bug.

## Commit / PR conventions

- Conventional commits: `feat(scope): …` / `fix:` / `chore:` / `docs:`. Wrap bodies ~72 cols.
- `main` is protected — changes land via PR. Run the full gate (typecheck + lint +
  test + build) before pushing; CI runs the same.
- Keep this file current: if you change behavior an agent relies on (commands, the
  read loop, a gotcha), update AGENTS.md **in the same PR**.
