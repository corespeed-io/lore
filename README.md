<h1 align="center">
  <img src="public/lore-mark.svg" alt="" width="36" height="36"><br>
  Lore
</h1>

<p align="center">
  <strong>Browse your knowledge graph in the browser.</strong><br/>
  A knowledge-graph console — force-directed graph, dashboard, and hybrid search. Run it <strong>standalone</strong> on your own Postgres, or point it at a <a href="https://github.com/garrytan/gbrain">gbrain</a> backend.
</p>

<p align="center">
  <a href="https://github.com/corespeed-io/lore/actions/workflows/ci.yml"><img src="https://github.com/corespeed-io/lore/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Next.js-15-black?logo=next.js&logoColor=white" alt="Next.js 15">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript">
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> &nbsp;·&nbsp;
  <a href="#deploy-your-own">Deploy</a> &nbsp;·&nbsp;
  <a href="#configuration">Configure</a> &nbsp;·&nbsp;
  <a href=".github/CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">
  <img src="docs/graph.png" alt="Lore — a force-directed graph of a gbrain knowledge base" width="820">
</p>

## What is Lore?

Lore is a web console for a personal knowledge graph — your notes, people, projects, and the links that connect them — rendered as a force-directed graph, a dashboard, and hybrid search, so you can *see* and walk your knowledge instead of grepping it.

It runs two ways: **standalone**, serving its own brain out of Postgres + pgvector, or against an external **[gbrain](https://github.com/garrytan/gbrain)** over MCP. The browser console is read-only by construction either way — every write (vault import, `put_page`, `remember`) requires an explicit bearer token and never rides your viewer session.

## Features

- **Force-directed graph** — d3 node-link view with smooth zoom/pan, click-to-filter by type, and connection-walking from any node.
- **Dashboard** — pages, links, sources, daily activity, top hubs, and recent memories at a glance.
- **Hybrid search** — title + content search over your gbrain, as you type.
- **Bring your Obsidian vault** — pick a folder at `/import`; files become pages, folders become slug prefixes, and `[[wikilinks]]` become edges (including the ones in frontmatter, Markdown-style links, and aliases). Export the whole brain back out as a tar of `slug.md` from `/api/export`.
- **Agent memory** — an immutable event log, versioned thread summaries, and typed durable memories with provenance, supersession and historical (`as_of`) recall. Agents use `remember` / `recall` / `forget` / `inspect_memory`; memories are projected into the same graph and search as everything else, and a correction supersedes rather than overwrites.
- **Graph health** — the dashboard names the two reasons a graph looks empty: links pointing at pages that don't exist, and pages nothing points at.
- **Pluggable viz modules** — drop in a new `src/lib/viz/<name>.ts` to add a visualization.
- **Fail-closed auth** — none (dev), HTTP Basic, or Cloudflare Access (JWT-verified). The viewer console is read-only by construction; writes need their own `BRAIN_WRITE_TOKEN`.
- **Deploy anywhere** — standalone Docker image; one-click to Vercel or Railway.

<p align="center">
  <img src="docs/dashboard.png" alt="Lore dashboard — counts, activity, top hubs and sources" width="820">
</p>

## Quickstart

Two ways to run lore:

**Standalone (no gbrain)** — bring only a Postgres with `pgvector` and `pg_trgm` (e.g. a free [Neon](https://neon.tech) database). PostgreSQL **12 or newer**; tested on 17 and 18. Lore serves its own brain: hybrid search (vector + keyword + trigram), a wikilink graph, and an MCP endpoint at `POST /api/mcp` your agents can write memories to (`put_page` / `remember_note` / `delete_page` for pages, `remember` for agent memory; bearer `BRAIN_WRITE_TOKEN`).

```bash
git clone https://github.com/corespeed-io/lore.git && cd lore
cp .env.example .env        # set DATABASE_URL + EMBEDDINGS_* (leave GBRAIN_MCP_URL unset)
npm install && npm run dev  # → http://localhost:3000
```

**With a gbrain backend** — point `GBRAIN_MCP_URL` at a running [gbrain](https://github.com/garrytan/gbrain) MCP endpoint and set `GBRAIN_TOKEN` (or a read-only OAuth client) in `.env`.

## Deploy your own

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/corespeed-io/lore&env=GBRAIN_MCP_URL,GBRAIN_TOKEN,AUTH_MODE,ALLOW_INSECURE&envDescription=Point%20at%20your%20gbrain%2C%20then%20choose%20an%20auth%20mode&envLink=https://github.com/corespeed-io/lore/blob/main/.env.example)

> **Lore [fails closed](#configuration).** A fresh deploy returns `403` until you set `AUTH_MODE` — `proxy` (Cloudflare Access) or `password`, or `none` **with** `ALLOW_INSECURE=1`. It will not serve a private brain by accident.

Lore is a standard Next.js standalone app, so it also runs on **Railway** (Dockerfile auto-detected) or any container host:

```bash
docker build -t lore . && docker run -p 3000:8080 --env-file .env lore
```

Or on **Cloudflare Workers** (via OpenNext) — put any Postgres behind a [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) binding (free plan included; see `wrangler.jsonc`):

```bash
npx wrangler hyperdrive create lore-db --caching-disabled --connection-string="postgres://…"
npx wrangler secret put EMBEDDINGS_API_KEY   # + BRAIN_WRITE_TOKEN, UI_PASSWORD…
npm run cf:deploy
```

## Configuration

Config is entirely environment-driven — see [`.env.example`](.env.example) for the full list.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | standalone | Postgres 12+ with `vector` + `pg_trgm` — set this and leave `GBRAIN_MCP_URL` unset |
| `BRAIN_WRITE_TOKEN` / `BRAIN_READ_TOKEN` | standalone | Agents' bearer for the MCP endpoint; ≥16 chars or refused |
| `GBRAIN_MCP_URL` | remote mode | Your gbrain MCP server endpoint (omit for standalone) |
| `GBRAIN_TOKEN` | \* | Static bearer (server-only, never sent to the browser) |
| `GBRAIN_CLIENT_ID` / `GBRAIN_CLIENT_SECRET` | \* | **Preferred**: a read-only OAuth client — Lore mints short-lived tokens |
| `APP_TITLE` / `APP_SUBTITLE` | no | Hero branding, per deployment |
| `AUTH_MODE` | no | `none` · `password` · `proxy` (Cloudflare Access). Defaults to `none` |
| `ALLOW_INSECURE` | no | Required to actually run with `AUTH_MODE=none` (auth fails closed otherwise) |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | for proxy | Cloudflare Access team domain + audience |

\* Provide **either** `GBRAIN_TOKEN` **or** a client id/secret. A **read-only** client is recommended so a leaked credential can't write.

**Auth fails closed.** `none` is honored only when `ALLOW_INSECURE=1` is also set; `proxy` verifies the Cloudflare Access JWT (signature, audience, issuer, expiry) and denies if it's misconfigured. Never expose the origin with `AUTH_MODE=none` to the internet.

## Extending — add a visualization module

```typescript
// src/lib/viz/<name>.ts
export function mount<Name>(element: HTMLElement, data: GraphData, options: VizOptions): void {
  // render with d3, canvas, or the DOM
}
```

Mount it from `src/components/GraphView.tsx` and add a test in `tests/`.

## Development

```bash
npm run dev        # dev server (hot reload)
npm run typecheck  # tsc --noEmit
npm run lint       # biome
npm test           # vitest
npm run build      # production build
```

Working with an AI coding agent? **[`AGENTS.md`](AGENTS.md)** is the single source of truth — Claude Code, Codex, Cursor, Gemini, and Copilot all read it.

## Contributing

Issues, ideas, and PRs are welcome — start with [CONTRIBUTING.md](.github/CONTRIBUTING.md) or open a [discussion](https://github.com/corespeed-io/lore/discussions). Built and maintained by [CoreSpeed](https://github.com/corespeed-io).

## License

[MIT](LICENSE) © CoreSpeed
