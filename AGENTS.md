# AGENTS.md — Lore

Orientation for AI coding agents (Claude Code, Codex, Cursor, Gemini, Copilot, …)
working in this repo. **This file is the single source of truth.** `CLAUDE.md` is a
symlink to it and `.github/copilot-instructions.md` points to it — only ever edit
*this* file (no copies to drift). Codex, Cursor, and Gemini CLI read `AGENTS.md`
natively. (On a Windows checkout without symlink support, `CLAUDE.md` may clone as a
text stub — set `git config core.symlinks true`.)

## What this is

**Lore** is one small thing: a knowledge-graph console that serves its own brain.
Postgres + pgvector holds the pages, the wikilink graph and the durable agent
memories; there is no second backend to run, and no other service to configure.

Two doors into the same store, and the split IS the security model:

- **The console** (Dashboard, force-directed graph, Memories browse, hybrid search)
  reaches the brain through `/api/call`, which passes `"read"` into the dispatcher.
  `handleRpc` decides from each tool's own declared `access`, so a write tool is
  unreachable from a browser session whatever it asks for. There is deliberately no
  second hand-written allowlist — the one that existed had 13 of its 28 entries
  naming tools that exist nowhere in this repo, which is what a second copy of a
  registry always becomes.
- **Agents** reach it through `POST /api/mcp` (plus `/import`, `/api/maintenance`,
  `/api/export`) with a bearer: `BRAIN_WRITE_TOKEN` for read+write, `BRAIN_READ_TOKEN`
  for read-only.

This repo used to also proxy an external `the brain` and carry an admin console for
it. Both are gone (~2200 lines): the admin surface hard-required a brain
`/admin/api/*` backend, so no standalone deployment could turn it on. **Do not
reintroduce a second backend mode** — one store, one path, is the point.

Branding split: the app is **Lore** (sidebar wordmark, `<title>` prefix). The brain
it views is named by `APP_TITLE` (hero title, e.g. "CoreSpeed Library") and described
by `APP_SUBTITLE` (hero subtitle). Both are per-deployment env, so the OSS default
stays generic — don't hardcode a brand into components.

## Stack

- Next.js 15 (App Router) · React 19 · TypeScript
- d3 (graph viz only — **no chart library**; the dashboard chart is hand-rolled SVG)
- jose (trusted-gateway JWT verification) · Biome (lint + format) · Vitest (tests)
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

Required env (see `.env.example`): `DATABASE_URL` plus the `EMBEDDINGS_*` group —
a write embeds BEFORE its transaction, so an unconfigured embeddings provider is a
hard failure, not a degraded mode. **Auth fails closed**, so for local dev set
`AUTH_MODE=none` **and** `ALLOW_INSECURE=1` — otherwise every route returns 403. Before opening a PR, all of
typecheck + lint + test + build must pass (this is what CI runs).

**GOTCHA — never write a raw control byte into source; write the `\uXXXX` escape.**
Not just NUL: `tests/vault-injection-sweep.test.ts` shipped with three raw NULs, a
vertical tab and a form feed, all as literal bytes inside a list of traversal
vectors. A file containing a NUL is classified as BINARY by grep, which then
silently prints NO MATCHES for strings that are in it — `grep -n "etc.passwd"` on
that file returned nothing, and `grep -n '^test('` reported no tests. That is how
it came to hold two tests that asserted nothing, a live path-traversal bug and two
silent data corruptions while looking fine in review. Git's binary heuristic sniffs
only the first 8000 bytes and the NULs sat at 8437, so the diff still rendered;
"it looked fine in the diff" is not evidence.

**Do not try to check this with `grep`.** `grep -qP '\x00'` does not detect NUL
bytes (on macOS it reported this very file clean; PCRE reads the subject as a C
string), and `grep -q "$(printf '\000')"` has its NUL eaten by command
substitution, leaving an empty pattern that matches every file. Both report clean,
always. Two fast smell tests that do work: `file <path>` says `data` instead of
`ASCII text`, and `git diff --numstat` prints `-\t-` instead of line counts. Scan
with a reader that cannot lie — Python over `git ls-files -co --exclude-standard`
(`-co`, so a NEWLY ADDED file is in scope; `git diff --name-only` lists tracked
MODIFIED files only and misses it by construction).

The check is `tests/smoke.test.ts` now, so CI does it and nobody has to remember.
It scans every C0 control except tab/LF/CR plus DEL, names the file AND the byte,
and — because this class of bug has twice been a check that failed silently — **it
proves itself first**: a companion test runs the detector against a buffer holding
each forbidden byte and fails if any goes undetected. A rule enforced by discipline
is a rule with a path around it; a check nobody has watched fail is a rule that may
not be enforced at all.

**GOTCHA — a test that cannot falsify the fix it covers.** Two shapes, both
shipped here, and the second was found only AFTER the first was written down.

(1) HOLLOW: the test never reaches the fix through the door production uses — it
calls a helper or the database directly, so it asserts a property of the HARNESS
(that PGlite has a clock, that PGlite stores microseconds, that a shared helper
agrees with the SQL beside it) and stays green when the fix is deleted. Five of
these shipped. **Coverage cannot catch them**: the changed line runs — verified —
but no assertion's truth value depends on it. A guard proving the harness can do X
is not evidence the CODE does X, and the guard's presence is what makes it feel
safe.

(2) PREMISE-SHARING: the test drives the real path and DOES go red when the fix is
removed, but rests on the same assumption the fix does. The import collision guard
assumed "a batch is one restore"; the test posted one batch; the real client posts
25 at a time. The test agreed with the bug instead of testing it, and it passed
every check written for shape (1).

(3) PARTS-NOT-DATAFLOW: where behaviour genuinely cannot be reached — a React
component a node test cannot drive — the fallback is a structural pin, and a pin
that checks the fix's PIECES EXIST will survive a refactor that leaves them
orphaned. The import fix had three parts (fold before slicing, refuse both
collided files, post only the remainder); the pin covered two. Leaving the fold and
the filter expression intact and reconnecting only the loop to the unfiltered list
passed the whole suite with the data loss restored. **A structural pin must assert an UNBROKEN
CHAIN of bindings, not the presence of tokens** — and "data flow" is not enough of
a rule on its own: the repaired pin asserted three links of that flow as separate
fragments and was defeated again, one line along, by keeping every fragment alive
and rebinding one of them — and better, SHRINK WHAT NEEDS
PINNING: extract the decision into a pure function (`planRestore`), test that by
behaviour, and let the pin assert only that the component uses what it returned.
That took the untestable surface from three lines to one.

The check for all three: **derive the test from the THREAT, not from the fix.** A test
written by looking at your change encodes your change's assumptions, including the
wrong ones. Ask what the user actually does — restore a vault, which is many POSTs
— and make the test do that. And: **a fix justified by a claim about a caller must
be verified by READING that caller.** A claim about `page.tsx` asserted in a
comment inside `route.ts` is not evidence; grep the caller.

Then reverse-verify: reintroduce the exact pre-fix expression, watch the named test
go red, capture the message, restore. Name the assertion that will fail BEFORE
running the suite — if you cannot, the test is hollow. Prefer shipping the mutation
WITH the test, the way `tests/smoke.test.ts` proves its own detector before
trusting its scan.
ponytail: the unskippable version of reverse-verification is a registry of
`(file, anchor, pre-fix expression)` pairs plus a CI job that applies each one and
requires the named test to go red — which is what would have caught both defeats
of the import pin without a reviewer having to find them by hand.

**GOTCHA — do not run `npm run build` while `npm run dev` is running.** They share
`.next/` and the build clobbers the dev webpack manifest → dev serves a blank page
(`__webpack_modules__[moduleId] is not a function`). To build: stop dev, `rm -rf
.next`, build, then `rm -rf .next` and restart dev.

## The brain

Postgres + pgvector (e.g. Neon, or a local one) holds everything. There is no
backend-selection branch left to reason about — one store, one path.
graph, search, page view) works unchanged.

- `src/server/db.ts` — driver-free `Db` seam (`query` + `tx`) plus `initSchema`:
  pages / chunks / edges / pending_links / meta over pgvector + pg_trgm. The
  `meta` row pins the embedding space — **changing `EMBEDDINGS_MODEL`/`_DIM`
  fails loud** (re-embed required); never weaken that assert.
- `src/server/pipeline.ts` — chunking, `[[wikilink]]` extraction (fences
  stripped), OpenAI-compatible embeddings client (`EMBEDDINGS_URL/_API_KEY/
  _MODEL/_DIM`). `EmbedFn` takes a **role** (`"query"` | `"document"`, default
  document): the strong 2026 retrieval models are trained asymmetrically and want
  a one-line task instruction on the query only, so `EMBEDDINGS_QUERY_PREFIX` is
  prepended for `"query"` and nothing else. Unset ⇒ byte-identical to before, so
  a model that wants no instruction (bge-m3) is unaffected. The prefix is **not**
  part of the pinned embedding space — it changes how a query is encoded, not
  what is stored, so it needs no re-embed and must not reach the meta assert.
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
  **`body` is the exception and is `required`** — omitting it used to mean `""`
  (`String(args.body ?? "")`), so `put_page{slug, title}` silently wiped a page's
  body, chunks, embeddings and out-edges and answered `unchanged:false`,
  `isError:false`. `handleRpc` now enforces every tool's declared `required` at
  the door, so the schema is the list and no handler has to remember. **`null`
  counts as absent; `""` does not** — most clients serialise an omitted optional
  as `null`, so an `=== undefined` test fixed the spelling of the bug and not the
  bug, while clearing a body IS a thing a caller may legitimately mean. The tool
  description says so too, or the model reads only the old promise. Never drop a
  field from a `required` array to make a call convenient.
  `list_pages` takes `kind` (`memory` | `note`) so a client can list memories
  without pulling every page. There is deliberately no bulk-wipe tool: a
  client loop over `delete_page` covers it, and an unrecoverable mass delete
  on an agent-callable surface is a worse default than the tedium.
- Delete/restore invariant: `delete_page` sets `deleted_at` AND drops the
  page's chunks — the vector arm's inner query must stay a bare
  `ORDER BY … LIMIT` to keep HNSW, so its candidates are filtered by
  `deleted_at` only AFTER the LIMIT, and dead chunks would permanently steal
  ANN slots. `restore_page` therefore has to re-embed, and it is **one transaction with
  the embed taken first**: the earlier shape (clear `content_hash`, then re-put)
  was two statements around a network call, so a provider failure left a live,
  zero-chunk page that the vector arm could never see AND that no longer looked
  deleted, i.e. permanently unrestorable. Embedding before the transaction means
  a failure leaves the page deleted and the restore retryable. Reverse-verified
  in `tests/brain-store.test.ts`.
- `remember_note` (the page-level write; renamed from `remember` when the
  Agent Memory tool took that name — `mergeTools` now throws on a collision
  instead of silently shadowing) de-duplicates an exact repeat (same body + same frontmatter)
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
  caught it). Known limitation, documented at the column: SQL cannot do NFKC, so
  the basename arm can't reach a filename whose only difference from the ref is
  Unicode normalization (macOS NFD, fullwidth, ligatures). Closing it needs a
  schema bump plus a table rewrite; the ref-side normalizer is deliberately not
  half-fixed to hide it. `extractRefs` reads wikilinks AND Markdown links from the body
  AND from frontmatter string values, masks fenced *and* inline code, and skips
  `!` embeds. The forward-reference query in `putPage` is a **candidate filter
  only — `resolveRef` is the single authority**. That split is the fix for a real
  bug: the query used to re-implement the matching (against the wrong
  normalization, so slug- and path-style parked refs never landed at all, which
  is exactly the edgeless-graph symptom a directory-order vault import produces).
  If you find matching logic written twice, that duplication IS the bug.
- `put_page` returns `pending[]`: the refs that resolved to nothing, so an
  agent can correct a typo in the same turn. `find_orphans` (pages nothing
  points to) and `list_broken_links` are the human-facing halves.
- `rename_page` changes the slug in place and appends the old slug to that
  page's own aliases, which is what keeps stale `[[old-slug]]` refs elsewhere
  resolving. It deliberately does **not** rewrite other pages' bodies —
  that would mutate notes the user didn't touch, change their content_hash,
  and re-embed every referrer.
- **Server requirement: PostgreSQL 12+ with `vector` (pgvector 0.5+) and
  `pg_trgm`.** The floor comes from stored generated columns (`basename`, `fts`);
  everything else used here predates 12. Verified against **17.10 and 18.4**
  (18 is the current stable; 19 was still Beta 2 as of 2026-07-16 and is not a
  target). CI runs on **PGlite 0.4.3, which is Postgres 17** — so a
  version-specific problem on a newer server would not show up there, which is
  why the migration and memory paths are also exercised against a real server.
- Schema is at **v7** (v5 collapsed the memory scope, v6 added
  `chunks.context`/`chunks.source` for contextual retrieval, v7 moved the
  semantic sweep's progress marker out of the edge table and deleted the
  self-edge rows it had written). The memory tables are declared in
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
  `{from_slug,to_slug}` rows) plus write tools `put_page` / `remember_note` /
  `delete_page` for agents. `mergeTools` merges the memory registry in and
  **throws on a duplicate name** — the earlier `Object.assign` silently let the
  memory `remember` shadow the page-level one.
- `src/app/api/mcp/route.ts` — stateless Streamable-HTTP MCP endpoint for
  agents. Its own bearer auth: `BRAIN_WRITE_TOKEN` (read+write) /
  `BRAIN_READ_TOKEN` (read-only), both ≥16 chars, fail-closed when unset;
  middleware exempts `/api/mcp` from viewer auth for exactly this reason —
  don't remove either side of that pairing.
- **MCP revision: dual-era, `2026-07-28` + the 2025 handshake ones.** That
  revision made MCP stateless, which cost lore nothing (a route handler with no
  session table) and removed features a tools-only brain never had. What it did
  owe: `server/discover` (a **MUST**), `resultType` on every result, `ttlMs` +
  `cacheScope` on `tools/list`, deterministic tool order, and an **honest version
  answer**. `initialize` used to return `params.protocolVersion ?? "…"` — it
  ECHOED the request, so a client asking for a revision lore implements none of
  was told yes. Modern clients declare the version per request in
  `_meta["io.modelcontextprotocol/protocolVersion"]`; an unsupported one is
  refused with `-32022` listing `SUPPORTED_VERSIONS`. `resultType` is stamped in
  one place in `handleRpc` so a method added later cannot forget it, and
  `cacheScope` on `tools/list` is **`private`** because the visible tool list
  varies by bearer — a shared cache must never hand a write token's list to a
  read token. `server/discover` is `public`: same answer for everyone, no tool
  list in it.
- **The HTTP status is part of the protocol, not decoration.** `-32022`
  (UnsupportedProtocolVersion) and `-32020` (HeaderMismatch) MUST be `400`,
  unknown method MUST be `404` — a dual-era client only inspects the BODY of a
  `400` before deciding whether to fall back to `initialize`, so answering `200`
  told it a legacy exchange had succeeded. `HTTP_STATUS_FOR_ERROR` maps them and
  `/api/mcp` applies it; a new protocol error code needs an entry there too.
- **Header/body agreement is checked in the route**, the only layer that sees
  both (`headerRefusal`). The version refusal was bypassable while it read only
  `_meta`: `MCP-Protocol-Version: 2099-01-01` with no `_meta` got the full tool
  list. The spec's reason is the real one — an intermediary may route on the
  header while the server executes on the body. **Deliberate deviation:** the
  spec makes `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` REQUIRED and a
  missing one a `-32020`; lore validates them when present but does not demand
  them, because a 2025-era client predates the headers and `initialize` is still
  here to serve it. Disagreement is refused, absence is not. A `Mcp-Name` in the
  Base64 sentinel form (`=?base64?…?=`) is left to the body rather than compared
  raw — comparing it would refuse a *conforming* client.
- `bin/lore.mjs` — the terminal client, wired as the `lore` bin. **Zero
  dependencies and no build step**: node 20+ is already the floor and has global
  `fetch`, so it runs from a fresh checkout and there is no second dependency
  tree to drift from the server's. It exists for the two things curl is bad at —
  escaping a markdown body into JSON, and unwrapping `result.content[0].text` —
  and it treats `isError` as the FAILURE it is (exit 1, message on stderr)
  rather than printing the envelope and exiting 0. It speaks the modern
  revision (per-request `_meta`, no `initialize`), which also makes it the
  server's own conformance client — and `tests/cli.test.ts` spawns the real
  script against a stub server so that claim is checked rather than asserted.
  **Every request goes through the one `post()` door**: `sweep` used to call
  `fetch` directly and so had none of the token/401/status guards — it printed
  a refusal and exited 0, the exact failure the file's own comment condemns.
  It does NOT install skills; `npx skills add` owns that path.
- `skills/` — three `SKILL.md` files documenting lore's own tool surface:
  `lore-brain` (which write/read door), `lore-memory` (scopes, supersession, the
  event log), `lore-curate` (orphans, broken links, the background jobs). **Do
  not invent tool names** — the surface here is 24 tools, and a skill that names
  one that does not exist is worse than no skill.
  **`skills/`, not `.claude/skills/`, and the distinction is the point**: a
  vendor directory holds the skills a repo CONSUMES, and `skills/` holds the
  ones it PUBLISHES. These are lore's manual for any agent, so they are neither
  Claude Code's nor gitignorable. `skills/` is also the first path the
  [vercel-labs/skills](https://github.com/vercel-labs/skills) installer scans,
  which is what makes `npx skills add corespeed-io/lore` work with no npm
  package and no per-agent layout (verified: `npx skills add <path> --list`
  returns all three). Claude Code does not auto-load them from here — that is
  the trade, and it costs one `npx skills add .`. `lore skills install <dir>`
  is the same copy without the network.
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
  rather than truncated — reported as a final `EXPORT-SKIPPED.txt` entry INSIDE
  the archive, because the skip is discovered mid-stream when the headers are
  long gone. Validated by extracting with the system `tar`. Export takes the
  **write** bearer, not either one: it streams `exportBatch` straight out and
  never passes the MCP dispatcher, so it is the one door that bypasses the
  scoped-projection filter, and a full dump is an owner operation.
- Both routes plus `/api/mcp` authenticate with the SAME bearer pair via
  `src/server/auth-bearer.ts` — one rule, one place. Import needs
  `BRAIN_WRITE_TOKEN`; **so does export** — this line used to say "either token",
  contradicting the paragraph three lines above it and the route's own code, which
  compares `grantFor(...) !== "write"`. They are exempt from the
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

## Background jobs: mention linking and the semantic sweep

Two enrichment jobs share the `auto` edge lane, `POST /api/maintenance`, and
the same lease. Both are deterministic, zero-LLM, and reversible:
`{"action":"clear"}` (or `DELETE FROM edges WHERE lane='auto'`) undoes every
inference either ever made, and resets BOTH sweeps' progress markers so the
next run actually re-runs.

- **Mention linking** (`src/server/mentions.ts`, the default action) writes
  `lane='auto', kind='mention'`: pages that NAME a typed page get an edge to it.
- **Semantic sweep** (`src/server/semantic.ts`, `{"action":"semantic"}`) writes
  `lane='auto', kind='semantic'`: pages that are ABOUT the same thing, by
  mutual k-NN over the stored chunk vectors with a high floor (0.6, clamped to
  [0.3, 0.99]) and a per-page cap. Mutuality is what stops a vaguely-near-
  everything hub from becoming the centre of a meaningless star. **Progress
  markers are COLUMNS on pages** (`mentions_scanned_at`, `semantic_swept_at`),
  never rows in `edges`: the semantic sweep's first marker was a self-edge in
  the shared edge table, and every edge reader believed it — find_orphans
  answered [] forever, get_backlinks listed each page as its own backlink. The
  v7 migration deletes those markers and backfills the column.

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
schedulers cannot sweep at once — **compare-and-set at BOTH ends**: the winner
keeps the timestamp it wrote as a fencing token and releases only if the column
still matches it. Releasing unconditionally made this claim false for exactly the
case the lease exists for, because a holder that overran the timeout came back and
wiped the lease of the SUCCESSOR that had legitimately taken over, and every
overrun handed out one more concurrent sweep. It does at most 200 pages per call, and
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
concurrent appends. The in-transaction duplicate check is a fast path, not the
guarantee: under READ COMMITTED two concurrent replays can both pass it, so the
partial unique index on (`thread_id`, `idempotency_key`) is the authority and a
lost race is caught OUTSIDE the aborted transaction, reads back the winner's row
and returns the documented `{duplicate:true}` rather than a raw SQL error. Never store hidden chain-of-thought; redact secrets
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

**Safety** (`safety.ts`) is one gate every write passes, over the WHOLE payload
— `content` and `structured_value`, because the latter is stored on the row and
rendered into the projection's frontmatter, so screening only the prose lets a key
move one field to the left and walk through. `enrichMemory` is the second door
into that column and screens too. Secrets are REJECTED. The payload walker pairs
every string leaf with **every object key that encloses it**, at any depth and
through any container: `labelled_credential` is an ADJACENCY pattern (the label is
the only evidence, the value has no shape to test), and pairing it only with a
STRING value was a list of one container shape — `{api_key: ["…"]}`, which is
exactly what an imported vault's frontmatter block array parses to, walked through
a screen that refused the identical scalar. Two residuals, both judged rather than
hidden: a secret **split across two sibling fields** is not detected (n fields have
2^n concatenations, so any partial version is a list — and it costs a
`BRAIN_WRITE_TOKEN`, i.e. the owner, while the party this screen protects against
holds `BRAIN_READ_TOKEN` and cannot write at all); and the extra pairing makes the
walk O(leaves x depth), which is bounded two ways — `mcp.ts` refuses on the
caller's GRANT before screening, so a read token cannot buy the walk at all, and
`MAX_DEPTH` refuses a payload nested deeper than it can screen rather than failing
open on the part it cannot reach. Specific timings live in the round-5/6 commit
messages, not here: an inline benchmark figure goes stale silently and nothing
checks it.
Instruction-shaped content is DEMOTED, not deleted: it stays searchable content,
can never become a procedure, and never auto-commits. A memory cannot widen
authorization — structurally, because no memory type is consulted for tool
permissions.

**Projection** (`projection.ts`). Stable slug per memory — `memory/vault/<id>`,
and **that is the only shape**: `projectionSlug` returns `string | null`, and null
("this memory owns no page, ever") is the answer for every thread- and
agent-scoped memory, because only vault scope is projected into the shared graph.
The older `memory/thread/<scope>/<id>` spellings exist only as rows an earlier
release wrote, which `migrateMemoryNamespace` sweeps out at boot. A stable slug is
what makes a retry an update
instead of duplicating. Retired memories have their page soft-deleted, so a
superseded value leaves active search at once. A projection failure leaves the
memory `committed` with `projection_status='failed'` — canonical truth does not
depend on a page. **The `memory/` namespace is reserved and EVERY user write path refuses it** —
`put_page`, `/api/import`, `rename_page` (both ends, so a projection cannot be
moved out either) and `restore_page`. Guarding some and not others is how a
generated page gets clobbered, and that shipped once before a test caught it;
the rename/restore halves shipped missing a second time and a review caught them.
A projection is addressed by its stored `projection_page_id`, never by slug, so a
page that drifted off its canonical slug is still retracted when its memory is
revoked — addressing by slug is what let a renamed projection survive `forget`
and keep answering searches. `delete_page` on a live projection is **refused**
(`mcp.ts`'s `reserved` clause) — an earlier revision allowed it on the argument
that a page is a derived artifact so evicting one is a cache eviction rather than
a revocation, which ignored who holds the lever: a caller knowing nothing but a
memory id could take that memory out of its owner's retrieval until the next
sweep, and was answered `not_found` — the same text as a miss — because the filter
ran on the RESULT, after the row had already been updated. `forget` is the
revocation path and it checks scope BEFORE it acts. A page deleted some other way
is still rebuilt by the next maintenance pass.

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
rather than creating a fact from nowhere — as an `agent_action`, never as a
`user_message`: extraction trusts "only the user speaks for the user", so a tool
that forged that actor could plant a user statement the next sweep auto-commits
and supersedes the real value with. A credential in the event content never
reaches the insert at all: `handleRpc`'s screen refuses the whole call above the
tool lookup, so no event is written. (This paragraph used to say the content "is
passed through `redactSecrets`" — that function was DELETED in 2befdf4 as
unsound, because a detector matches a MARKER and cannot bound a secret, so
rewriting deleted the label and kept the key body. There is no redactor; there is
a refusal.) The server decides scope; a
caller cannot pass a predicate or widen scope — and because a raw `memory_id` is
a scope-free handle, `forget` and `inspect_memory` both require the scope the
caller addresses and report an out-of-scope hit as `not_found`, so a caller cannot
even learn that another scope's memory exists. `forget` reports `forgotten` (and
`projection_failed`) rather than only "revoked": a revocation whose page retraction
failed has left the content live, and reporting success there tells the user their
data is gone when it is not.

**Extraction never widens scope** (`extract.ts`). Given a set of allowed scopes it
takes the NARROWEST that fits the source — thread inside agent inside vault — and
a correction may only retire a memory in the scope it writes to. The reverse
(vault winning over thread) turned anything said in one conversation into a global
fact readable from every other thread, which in a personal knowledge base is a
privacy defect, not a modelling one.

**Episodes and procedures** (`episodes.ts`). An episode stores observable
goal/actions/tools/result and CITES the event range instead of copying the trace.
A procedure needs two successful episodes, or one plus explicit approval, and
records required permissions as information only. **NOT WIRED, and read this
before building on it:** nothing in `src/` calls `recordEpisode` or
`promoteProcedure`, and `consolidateMemory` is invoked without a scope while
`findProcedureCandidates` only scans a scope it is given — so the "propose
procedures" stage cannot run at all. The surface is dead code kept for the host
that will drive it, which means its guarantees are UNTESTED IN ANGER: a reviewer
noted it accepts cross-scope episodes and an `approved` boolean the caller
supplies. Wiring it is a change that needs its own review, not a one-line call.

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
  Check `forgotten` in the result, not just `revoked`: `false` means the canonical
  row is revoked but its page retraction failed, so the content is still live and
  the call must be retried (the ids are in `projection_failed`).
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
| C page search | 0.375 | 0 | 0 | 0.333 | 1 | 734 |
| **D summary+memory** | **1.0** | **1** | **1** | **0** | **0** | 76 |
| **E D+graph** | **1.0** | **1** | **1** | **0** | **0** | 76 |

**Re-recorded 2026-08-01, and the C/D/E rows MOVED — said out loud rather than
quietly refreshed.** The numbers first recorded here (2026-07-31) predate the
round-3 decision to stop projecting thread- and agent-scoped memories into the
shared page graph. Page search is exactly the strategy that reads that graph, so
C fell from 0.875 to 0.375 recall and from 1 to 0 supersession — it can no longer
see private memories at all — and D/E's context shrank from 194 to 76 chars for
the same reason. No metric was lowered to make anything pass: the gate asserts
D and E's correctness columns, which are unchanged at 1/1/0, and the drop is in
the BASELINE the gate exists to beat. Verified against the pre-change tree
(`git stash`, re-run) so the movement is attributed to round 3, not to round 5.

The finding worth keeping is now sharper than it was: **page search alone has zero
temporal accuracy AND zero supersession accuracy, and it is the only strategy that
pulls in a distractor (1.0)** — which is why canonical filtering is not optional.
The gate asserts the CORRECTNESS metrics (supersession, staleness, temporal), not
taste: a ranking idea that improves recall while letting a superseded value through
is not an improvement. Embeddings, rerankers, autocut and similarity floors stay
gated behind this fixture plus the retrieval one.

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
  → resolves via brain → sets `openPage`. The page overlays the current tab; the
  back-button label is `TAB_LABELS[tab]` and back just clears `openPage`. Opening a
  page never switches tabs, so `tab` IS the origin. Don't reintroduce per-tab page state.
- `src/app/api/graph/route.ts` + `src/lib/graph.ts` — `/api/graph` seeds a page
  set from `list_pages` plus the seed queries, then reads the brain's **actual link graph**
  via a FEW deep `traverse_graph(direction=both)` calls from the most-relevant roots
  (`TRAVERSE_ROOTS`, `TRAVERSE_DEPTH`) — one bulk call returns a whole reachable
  neighborhood, so this covers the graph while keeping the brain request log quiet
  (the old `get_links`+`get_backlinks`-per-seed fan-out spammed it). `{nodes, links}`,
  **1h cached**. Edges come from the brain's typed/mentions/manual links — **not** a regex
  over the search snippet, which missed every link outside the matched chunk. **Drops
  hash-titled mem0 imports** (`isHashTitle`); isolated pages are kept only while
  the PROSPECTIVE total stays under `ISOLATED_BUDGET` (400) — measured before
  adding them, because an edgeless brain has zero connected nodes and a
  connected-only count sails under any budget exactly when the halo is worst.
  At 4k pages, 66% of the picture was degree-zero dots around the structure
  someone came to look at. Failure handling: every upstream
  read — seed queries, `list_pages`, traversals, including MCP `isError` results and
  non-edge-shaped payloads — feeds ONE failure signal. Zero fetched edges + any failed
  read ⇒ buildGraph **fails loud** (throws → route 502, logged, uncached) instead of
  caching an edgeless "everything scattered" (or empty) graph for the 1h TTL; edges
  survived + a failed read ⇒ served but NOT cached (next request retries); rebuilds are
  **single-flighted and stale-while-revalidate** — an expired graph is served stale
  immediately while one background rebuild refreshes it (a rebuild is 10–48s of brain
  traversals, and only the first-ever build blocks); a failed rebuild leaves the cache
  expired, so the next request retries and is served stale again rather than the 502.
  The dashboard renders the link stat as "—" (not 0) when the
  graph read failed. Slug == node id. Node `type` is dynamic: preserve the brain's returned `type` string
  and only infer `person` / `company` / `product` from slug prefixes when the backend
  did not return a type.
- `src/app/api/call/route.ts` + `src/lib/tools.ts` — `/api/call` proxies a brain
  MCP tool, gated by each tool's own `access` (the security boundary). It
  validates `tool` is a string and clamps unbounded args (`limit`/`depth`/…). Client
  calls go through `src/lib/api.ts` `apiCall(tool, args)`. **A tool is reachable from the console iff its `access` is `read`** — there is no list to add it to.
- `src/lib/viz/graph.ts` — d3 force graph. Exposes `mountGraph(el, data, opts)` →
  `{ destroy, highlight(idSet|null) }`. Zoom/pan (wheel + bg-drag), free node drag,
  dbl-click on empty space to fit. Two load-bearing invariants: (1) the layout
  settles HEADLESSLY at mount (`sim.tick` inside a time budget — no animated
  settle phase exists), and (2) **no paint touches the whole graph**: JS assigns
  membership classes only (`.match`/`.lit`/`.hovered`, `.graph-dimmed`/`.gsel` on
  the root) and the stylesheet — the `.lore-graph` paint table in `globals.css` —
  decides every visual, so removing a class IS the restore and there is no
  restore code to get wrong. Geometry (`cx`/`x1`/label positions) stays JS: those
  are attributes, not CSS properties. The hover dim engages on DWELL (150ms),
  never while sweeping. A GRAB dims immediately and owns the focus through the
  drag and after release: elements on BOTH pointer layers move under a
  stationary pointer (the hit layer every tick, nodes whenever the springs
  push one across it), so no boundary event may take or kill the focus during
  the hold — only real pointer travel ends it, and `holdVerdict` (pure,
  tested) is the one rule every handler consults. Don't reintroduce per-element style/attr writes in paint
  paths, and don't add a second reset path beside `clearLit()`.
- Components: `Sidebar` (nav + omnibox), `Overview` (dashboard), `ActivityChart`
  (fixed recent 180-day activity **bars**, hand-rolled SVG, pure `dailyCounts()`), `Breakdown`,
  `TopHubs`, `Sources`, `RecentActivity`, `GraphView`, `SearchResults` (Memories
  browse + type chips + ranked search), `PageView` (the memory page).

## Brain constraints

- `list_pages` returns `{slug, title, type, updated_at}` — **no per-page source_id**,
  so you can't filter the Memories list by source. It pages: `limit` (≤1000,
  default 100) plus `offset`, ordered `updated_at DESC, id DESC` — the id
  tiebreaker is load-bearing, because a batch import stamps hundreds of rows
  with one updated_at and a tie spanning a page boundary otherwise duplicates
  or drops rows. The console browse list pages to completion (cap 20,000).
- Search returns ranked chunks (`score`, `evidence`, `chunk_text`). `query` is a
  **literal alias of `search`** — no LLM expansion, no reranker. If you add either,
  give it its own tool name rather than quietly changing what `query` means.

## Security (it's a public repo serving a private brain — read this)

- **One boundary, and it is the tool's own `access`.** `/api/call` (the console)
  passes `"read"` into `handleRpc`, which refuses a `write` tool to a `"read"`
  caller. There is deliberately NO second allowlist: the one that existed drifted
  until 13 of its 28 entries named tools that do not exist. Never widen a tool from
  `write` to `read` to make a console feature convenient.
- **Agent credentials are separate from the viewer session.** `BRAIN_WRITE_TOKEN` /
  `BRAIN_READ_TOKEN` (≥16 chars, constant-time compare) gate `/api/mcp`, `/import`,
  `/api/maintenance` and `/api/export`. Export needs the **write** token even though
  it only reads — a full dump bypasses the read surface's filter.
- **Credentials are server-only**, guarded by `import "server-only"`. Never expose
  one to the client, never `NEXT_PUBLIC_*`, never commit `.env`.
- **A half-configured auth mode is a configuration ERROR, not an opening.**
  `AUTH_MODE=password` with no `UI_PASSWORD` is refused — it used to fall through to
  `allowInsecure`, so the documented local-dev pair silently served the whole console
  the moment the password was forgotten.
- **`AUTH_MODE=gateway` never trusts an identity header on its own.** A header is
  typed by whoever is talking to us, so `X-Forwarded-User` alone is a login form with
  no password. It is read ONLY after the gateway proves it is the gateway: a JWT
  verified against `AUTH_GATEWAY_JWKS_URL` (signature + issuer + audience + exp), or
  `AUTH_GATEWAY_SHARED_SECRET` compared in constant time. A configured JWKS decides
  ALONE — setting both proofs must not let a failed token fall back to the weaker
  one. Neither configured ⇒ every request is refused. **Do not add a "just trust the
  header" option**; a deployment that wants one can put the proxy on localhost and
  set a secret, which costs one env var and is not a footgun.
- **Auth** lives in `src/middleware.ts` → `src/lib/auth.ts`. **GOTCHA: the middleware
  file MUST stay under `src/`** — this project keeps code in `src/`, and Next.js
  silently ignores a root-level `middleware.ts` in that layout (it shipped fail-OPEN
  that way once: empty middleware-manifest, no 403s, no rate limits — verify with
  `python3 -c "import json; print(json.load(open('.next/server/middleware-manifest.json'))['middleware'])"`
  after a build if you touch it). `gateway` is described above; `password` = HTTP
  Basic, compared in constant time, and refused outright when `UI_PASSWORD` is
  unset; `none` denies unless `ALLOW_INSECURE=1`. An UNKNOWN `AUTH_MODE` falls
  back to `none`, which then fails closed on its own — so a deployment that still
  says `proxy` after this change denies rather than opens, unless it also carries
  `ALLOW_INSECURE=1`. `/api/health` is the only auth-exempt route (for the
  platform healthcheck).
- **The rate limiter keys on the right-most `x-forwarded-for` entry only.** It
  used to prefer `cf-connecting-ip` whenever the auth mode declared a proxy,
  which was safe only while that mode WAS Cloudflare Access — `gateway` covers
  any ingress, none of which set or strip that header, so a caller could send one
  and be handed a fresh bucket every request. Nothing was lost by dropping it:
  Cloudflare appends the real client to `x-forwarded-for` too.
- `/api/call` and `/api/graph` are rate-limited per user in middleware; `next.config.mjs`
  sets a strict CSP + security headers (`'unsafe-eval'` is dev-only).

## Known residuals (reviewed, deliberately open)

Filed by review and left open ON PURPOSE, so the next person finds them here
instead of rediscovering them. None is a privilege or data-exposure defect; each
says why it is not fixed, because "we know" is only useful if the reason is
written down.

- **A credential split across two SIBLING fields is undetected.** `{k1:"AKIA…",
  k2:"…"}` is two ordinary strings. Catching it means testing concatenations, and
  n fields have 2^n of them, so any partial version is a list — the shape that has
  lost every round here. It also costs a `BRAIN_WRITE_TOKEN`, i.e. the owner, while
  the party the screen protects against holds `BRAIN_READ_TOKEN` and cannot write.
- **`pages.basename` cannot do NFKC in SQL**, so the filename arm cannot reach a
  file differing from the ref only by Unicode normalization. Closing it needs a
  schema bump plus a table rewrite. Documented at the column.
- **The export/import round trip is not an IDENTITY for every accepted slug.**
  `put_page` deliberately accepts a slug named exactly (`Projects/Roadmap`,
  `trailing-`, a fullwidth or NFD spelling), `/api/export` writes `${slug}.md`, and
  `pathToSlug` folds it on the way back — so such a page comes back renamed. Links
  still resolve, because a path-shaped ref is compared by folded address. What is
  closed is the destructive case — two files that fold to one slug, one silently
  overwriting the other — and it is closed in TWO places because it needs both:
  `/api/import` reports an intra-batch collision, and `src/app/import/page.tsx`
  folds the WHOLE file list before it slices. The server alone was not enough, and
  an earlier version of this line claimed it was: the client posts `BATCH = 25`, so
  a restore is many POSTs and only the client ever sees the whole restore. Closing the rename half means either tightening `invalidSlug` (which
  removes deliberately supported slugs) or carrying the true slug in exported
  frontmatter (which puts a generated key in user data); both want their own review.
- **A bespoke importer posting to `/api/import` in several batches bypasses the
  whole-restore fold** and gets only the intra-batch check, so two files meaning one
  page can still overwrite. The shipped client is safe (`planRestore` folds the
  whole list before slicing). The server CANNOT close this statelessly — it has no
  way to know where one restore ends, so telling "overwrite" from "collision" needs
  a caller-supplied restore id or stored per-page provenance, i.e. a schema change.
  It costs a `BRAIN_WRITE_TOKEN`, i.e. the owner, over their own data with a script
  they wrote: a footgun, not a defect.
- **A fullwidth solidus makes `pathToSlug` and `refAddress` disagree** (`x-／-y.md`
  imports at `x-/-y`, a ref addresses `x/y`), because one splits before NFKC and
  the other after. A broken link, never a wrong edge.
- **A rejected caller on a BARE origin can mint rate-limit buckets** by rotating
  `x-forwarded-for`, which `clientAddr` reads unconditionally as a fallback. It
  buys 401s, which were free before the limiter existed. Bounding it needs a
  trusted-hop count in config, not more header sniffing.
- **A read token's traffic to a write-only route is charged to the shared address
  bucket** even though it can never succeed there. Fixing it means the middleware
  knowing each brain route's required grant — a second reader of a rule the routes
  already own, unless that rule is moved somewhere both can share.
- **An agent may adopt an unowned thread** (`ensureThread`'s first-writer claim),
  after which that thread's `user_message`s become citable for agent-scope
  revocations. It grants nothing new: an agent holding a user-stated agent-scope
  memory already owns a thread the user spoke in.
- **`local.ts` does not cache an init failure**, so every request against a brain
  whose boot repair fails closed builds another `pg.Pool`. Worse than an
  unreferenced object: `initSchema` issues queries before it can fail, so each
  orphaned pool has already opened a real socket and holds it until pg's idle
  timeout reaps it. It needs an AUTHENTICATED caller against an already-wedged
  brain, and it does NOT compose with the `/api/mcp` 404-before-401 residual —
  `resolveDatabaseUrl` builds no pool and `getBrainCtx` runs only after the bearer
  check. Node only. Fixing it properly needs a `close` on the `Db` seam, which is a
  change to the one infra-aware interface and wants its own review — that is the
  only reason it is here rather than fixed.
- **`renamePage` leaves a stale `content_hash`**, so re-putting the pre-rename
  payload answers `unchanged:true`. Bounded to the `aliases` key the rename itself
  adds.
- **`pageType` defaults to `note` while `lib/graph.ts`'s `nodeType` defaults to
  `concept`** for edge-discovered nodes, against a comment claiming they cannot
  diverge. Cosmetic: a node colour.
- **`/api/mcp` resolves the database URL before checking the bearer**, so an
  unauthenticated caller can tell 404 from 401 — unlike import/maintenance.
- **The procedure surface is dead code with known holes.** See the Episodes and
  procedures section: it is not wired, and wiring it needs its own review.

## Test gotchas (when verifying in a browser)

- Setting an input's `.value` + dispatching `input` does NOT trigger React 19's
  `onChange`. Use real keystrokes or the native value-setter.
- d3 click handlers need a real `MouseEvent` dispatched on the node (target by
  `circle.__data__.id`).
- Date strings are UTC (`updated_at`); render labels with `timeZone: "UTC"`.
- The dashboard renders all-zero until the client fetches the brain (~1-2s); that's the
  load state, not a bug.

## Commit / PR conventions

- Conventional commits: `feat(scope): …` / `fix:` / `chore:` / `docs:`. Wrap bodies ~72 cols.
- `main` is protected — changes land via PR. Run the full gate (typecheck + lint +
  test + build) before pushing; CI runs the same.
- Keep this file current: if you change behavior an agent relies on (commands, the
  read loop, a gotcha), update AGENTS.md **in the same PR**.
