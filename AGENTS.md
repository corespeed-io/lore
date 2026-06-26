# AGENTS.md — Lore

Orientation for AI coding agents (Claude Code, Codex, Cursor, Gemini, Copilot, …)
working in this repo. **This file is the single source of truth.** `CLAUDE.md`,
`GEMINI.md`, and `.github/copilot-instructions.md` are thin pointers to it — edit
*this* file, never copy content into them (copies drift and your AI behaves
differently per tool).

## What this is

**Lore** is the product — a read-only web UI for browsing a **gbrain** knowledge
brain. `gbrain` is the backend engine (hybrid retrieval: vector + BM25 + RRF +
rerank + a typed-edge graph). Lore **never writes** — it reads gbrain over MCP and
renders a dashboard, a force-directed graph, a Memories browse, and hybrid search.

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

Required env (see `.env.example`): `GBRAIN_MCP_URL`, `GBRAIN_TOKEN`. **Auth fails
closed**, so for local dev without Cloudflare Access set `AUTH_MODE=none` **and**
`ALLOW_INSECURE=1` — otherwise every route returns 403. Before opening a PR, all of
typecheck + lint + test + build must pass (this is what CI runs).

**GOTCHA — do not run `npm run build` while `npm run dev` is running.** They share
`.next/` and the build clobbers the dev webpack manifest → dev serves a blank page
(`__webpack_modules__[moduleId] is not a function`). To build: stop dev, `rm -rf
.next`, build, then `rm -rf .next` and restart dev.

## Architecture

- `src/components/App.tsx` — root state machine. One `tab` (`overview` | `graph` |
  `search`) plus a single `openPage` overlay. Opening a memory from ANYWHERE
  (dashboard panels, Memories list, graph nodes, wikilinks) calls `openMemory(slug)`
  → resolves via gbrain → sets `openPage`. The page overlays the current tab; the
  back-button label is `TAB_LABELS[tab]` and back just clears `openPage`. Opening a
  page never switches tabs, so `tab` IS the origin. Don't reintroduce per-tab page state.
- `src/app/api/graph/route.ts` + `src/lib/graph.ts` — `/api/graph` crawls gbrain
  (seed queries, fanned out in parallel → wikilink expansion) into `{nodes, links}`,
  10-min cached. **Drops hash-titled mem0 imports and isolated nodes** (`isHashTitle`)
  so the graph stays meaningful. Slug == node id.
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
  so you can't filter the Memories list by source.
- Search uses gbrain `search` (ranked chunks: `score`, `evidence`, `chunk_text`).
  `query` adds LLM multi-query expansion (slower) — `search` is right for as-you-type.

## Security (it's a public repo serving a private brain — read this)

- **Read-only is the contract.** `READ_ONLY_TOOLS` in `src/lib/gbrain.ts` is
  server-enforced (checked before the upstream fetch) and is the security boundary.
  Never add a mutating tool to it; never add a route that writes to gbrain.
- **`GBRAIN_TOKEN` is server-only.** It's used only in `gbrain.ts` (guarded by
  `import "server-only"`). Never expose it to the client, never `NEXT_PUBLIC_*` it,
  never commit `.env`.
- **Auth** lives in `middleware.ts` → `src/lib/auth.ts`. `AUTH_MODE=proxy` verifies
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
