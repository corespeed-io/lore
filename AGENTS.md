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
  only. Not implemented, by choice: bulk `ingest` (a client loop over
  `put_page` covers it) and `clear_all_memory` (single-user; `delete_page` in
  a loop, and an unrecoverable bulk wipe on an agent-callable surface is a
  worse default than the tedium).
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
