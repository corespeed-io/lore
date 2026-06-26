# Lore

Lore is CoreSpeed's open-source Next.js data-visualization app for gbrain, the knowledge graph indexing engine. Query your codebase, docs, or private knowledge base—and explore the connected concepts as an interactive graph.

## Features

- **Interactive graph visualization** — d3-powered node-link diagrams showing entity relationships
- **Full-text search** — query your gbrain MCP server and browse results
- **Pluggable viz modules** — add custom visualizations (page hits, entity types, timelines, etc.)
- **Flexible auth** — none, HTTP Basic password, or Cloudflare Access proxy mode
- **Docker & cloud-ready** — standalone container, runs on Vercel, Railway, or your infra

## Quickstart

### Local development

```bash
# Copy env template and fill in your gbrain credentials
cp .env.example .env

# Set these required variables:
# GBRAIN_MCP_URL=https://your-gbrain.example/mcp
# GBRAIN_TOKEN=gbrain_at_xxx
# (AUTH_MODE=none is fine for dev)

npm install
npm run dev
```

Open http://localhost:3000.

### Docker

```bash
docker build -t lore .
docker run -p 3000:8080 --env-file .env lore
```

### Deploy to Vercel

1. Push this repo to GitHub.
2. Create a Vercel project pointing to the repo.
3. Set environment variables: `GBRAIN_MCP_URL`, `GBRAIN_TOKEN`, `APP_TITLE` (optional), auth vars (optional).
4. Deploy.

### Deploy to Railway

1. Create a Railway project.
2. Connect your GitHub repo or upload the source.
3. Set environment variables (same as Vercel).
4. Railway auto-detects the Dockerfile and deploys.

## Configuration

### Environment variables

| Variable | Type | Required | Notes |
|----------|------|----------|-------|
| `GBRAIN_MCP_URL` | string | yes | Full URL to your gbrain MCP server endpoint |
| `GBRAIN_TOKEN` | string | yes | Server-only token; never exposed to browser |
| `APP_TITLE` | string | no | Page title; defaults to "gbrain" |
| `SEED_QUERIES` | string | no | Pipe-separated queries (e.g., `"topic one \|\| topic two"`); if unset, uses built-in defaults |
| `BRAND_COLORS` | JSON | no | Color map for entity types (e.g., `{"person":"#7F77DD","company":"#D85A30"}`); uses defaults if absent |
| `AUTH_MODE` | string | no | Authentication strategy; see table below; defaults to `"none"` |
| `UI_PASSWORD` | string | no | Password for `AUTH_MODE=password`; if unset, auth is disabled |
| `ACCESS_TEAM_DOMAIN` | string | no | Cloudflare Access team domain for `AUTH_MODE=proxy` |
| `ACCESS_AUD` | string | no | Cloudflare Access audience tag for `AUTH_MODE=proxy` |

### AUTH_MODE

| Mode | Use case | Config |
|------|----------|--------|
| `none` | No authentication | No env vars needed |
| `password` | Simple HTTP Basic | Set `UI_PASSWORD` to a secret |
| `proxy` | Cloudflare Access | Set both `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` |

**Security note:** `proxy` mode requires BOTH `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` to be set—otherwise it falls open.

## Development

### Commands

```bash
npm run dev        # Start local dev server (localhost:3000, hot reload)
npm run build      # Build for production
npm start          # Run production build locally
npm run lint       # Check code style with Biome
npm run format     # Auto-format code with Biome
npm run typecheck  # Type-check with TypeScript
npm test           # Run tests with Vitest
```

### Project structure

```
src/
├── app/               # Next.js app router
│   ├── layout.tsx     # Root layout + metadata
│   ├── page.tsx       # Search & graph UI
│   └── api/           # API routes
│       ├── graph      # Graph JSON endpoint
│       ├── call       # MCP tool invocation
│       └── health     # Health check
├── components/        # React components
│   ├── GraphView      # d3 visualization
│   ├── PageView       # Markdown rendering
│   └── ...
├── lib/
│   ├── types.ts       # Shared types (GraphNode, GraphLink, etc.)
│   ├── config.ts      # Config loading from env
│   ├── auth.ts        # Auth middleware
│   ├── gbrain.ts      # MCP client
│   ├── graph.ts       # Graph construction logic
│   ├── markdown.ts    # Markdown parsing
│   └── viz/
│       ├── graph.ts   # Graph viz module
│       └── ...        # Other viz modules
└── ...
```

## Adding a visualization module

1. Create `src/lib/viz/<name>.ts` exporting a render function:
   ```typescript
   export function mount<Name>(element: HTMLElement, data: GraphData, options: VizOptions): void {
     // Use d3, canvas, or DOM APIs to visualize data
   }
   ```

2. Import and mount in `src/components/GraphView.tsx`.

3. Run tests: `npm test`.

## Support

- **gbrain docs** — https://github.com/corespeed-io/gbrain
- **Next.js docs** — https://nextjs.org/docs
- **d3 docs** — https://d3js.org
