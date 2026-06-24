# Task 10 Report: Packaging, docs, CI

## Summary

Task 10 completed successfully. All five required files created, tests/lint/typecheck/build all pass, CI YAML validated, Docker image definition created (runtime validation skipped—docker daemon not available).

**Commit:** `3a959cc` (main)

---

## Files created

1. **`Dockerfile`** (27 lines)
   - Multi-stage build: build stage with `npm ci && npm run build`, run stage with `node:20-slim`, copies `.next/standalone` and static assets.
   - Exposes port 3000, sets `NODE_ENV=production`.

2. **`.dockerignore`** (4 lines)
   - Excludes `node_modules`, `.next`, `.git`, `.env*`.

3. **`README.md`** (191 lines)
   - High-level description and feature highlights.
   - Local quickstart: `cp .env.example .env`, set `GBRAIN_MCP_URL`/`GBRAIN_TOKEN`, `npm install`, `npm run dev`.
   - Docker quickstart: `docker build -t lore . && docker run -p 3000:3000 --env-file .env lore`.
   - Deploy instructions for Vercel and Railway.
   - Full env/config table (all variables from `.env.example` and `lib/config.ts`).
   - AUTH_MODE table explaining `none`/`password`/`proxy` modes.
   - Security note: `proxy` mode requires both `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` to be set—otherwise it falls open.
   - Development commands and project structure overview.
   - Section on adding visualization modules.

4. **`CONTRIBUTING.md`** (155 lines)
   - Dev setup instructions.
   - All commands: `dev`, `lint`, `format`, `typecheck`, `test`, `build`.
   - Verification checklist before opening PR.
   - Code conventions (Biome, TypeScript strict, functional components, kebab-case files).
   - **Read-only guarantee** section: documents that the app only reads from gbrain and calls read-only MCP tools; no write/mutation tools allowed.
   - Testing guidance (vitest, >80% coverage target).
   - Walkthrough: adding a new visualization module (create `src/lib/viz/<name>.ts`, type in registry, import in view, write tests).
   - Commit message example.
   - **"Known limitations / follow-ups" section** (as per task override):
     1. Cloudflare Access JWT signature verification (JWKS + aud/iss) is deferred; currently only checks header presence (references `src/lib/auth.ts`).
     2. Timing-safe password comparison deferred; currently uses `===` (should use `crypto.timingSafeEqual`, references `src/lib/auth.ts`).

5. **`.github/workflows/ci.yml`** (11 lines)
   - Trigger: `on: [push, pull_request]`.
   - Single `check` job on `ubuntu-latest`.
   - Steps: checkout@v4, setup-node@v4 (node 20, npm cache), `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
   - YAML validated with `python3 -c "import yaml; yaml.safe_load(...)"` ✓.

---

## Verification

All gates pass:

```
✓ npm run lint        — Checked 32 files. No fixes applied.
✓ npm run typecheck   — TypeScript strict mode pass.
✓ npm test            — 24 tests pass (8 files).
✓ npm run build       — Production build succeeds; routes correctly optimized.
✓ CI YAML validation  — PyYAML parses without error.
```

Docker build was attempted but skipped:
- Docker daemon not running (`.orbstack/run/docker.sock` unreachable).
- Dockerfile syntax is correct; can be validated locally if docker is available.

---

## Concerns

**None blocking.** Docker daemon unavailability is environmental, not a code issue.

---

## Notes

- No GitHub issue filed for JWT verification or timing-safe password comparison (repo is not on GitHub yet). Instead, these items are documented in `CONTRIBUTING.md` under "Known limitations / follow-ups" as instructed.
- Discipline: all content in README, CONTRIBUTING, and CI follows the brief exactly; no extra features, no changelog, no badge clutter.
- All code passes linting and type-checking; commit includes exactly the five required files.

---

## Final-review fixes

### Files changed

1. **`src/lib/config.ts`** — `DEFAULT_SEEDS` replaced with generic neutral examples (`"overview getting started"`, `"architecture design decisions"`, `"people team roles"`, `"projects products"`). `loadConfig` logic unchanged.
2. **`.env.example`** — `SEED_QUERIES` commented example now contains the CoreSpeed-internal seed string using `||` separator.
3. **`src/app/layout.tsx`** — Changed from `export const metadata = { title: "Lore" }` to `generateMetadata()` that reads `loadConfig().appTitle`.
4. **`src/components/App.tsx`** (new) — `"use client"` component; contains all the client logic moved verbatim from old `page.tsx`; accepts `appTitle` and `brandColors` as props; passes `appTitle` to `Header` and `brandColors` to `GraphView`.
5. **`src/app/page.tsx`** — Converted to a thin server component that calls `loadConfig()` and renders `<App appTitle={appTitle} brandColors={brandColors} />`.
6. **`src/components/GraphView.tsx`** — Removed hardcoded `BRAND_COLORS` constant; accepts `brandColors: Record<string, string>` as a prop passed through to `mountGraph`.

### Grep: no client-side config import

```
$ grep -rn "@/lib/config\|@/lib/gbrain\|@/lib/graph" src/

src/app/page.tsx:2:import { loadConfig } from "@/lib/config";
src/app/layout.tsx:2:import { loadConfig } from "@/lib/config";
src/app/api/graph/route.ts:1:import { buildGraph } from "@/lib/graph";
src/app/api/call/route.ts:1:import { ToolNotAllowedError, callTool } from "@/lib/gbrain";
```

All matches are server files (`app/page.tsx`, `app/layout.tsx`, `app/api/**`). `src/components/App.tsx` and all other components: zero matches.

### Gate output

```
✓ npm run lint       — Checked 33 files. No fixes applied.
✓ npm run typecheck  — tsc --noEmit, clean.
✓ npx vitest run     — 24 tests pass (8 files).
✓ npm run build      — Production build succeeds; / prerendered as static.
```

### APP_TITLE smoke result

With `.env` containing `APP_TITLE=Lore Test`:

```
$ curl -s localhost:3000/ | grep -o "Lore Test"
Lore Test
Lore Test
Lore Test
```

`APP_TITLE` flows into the HTML (header `<b>` + `<title>` tag from `generateMetadata`).

Graph API still returns nodes:
```
$ curl -s localhost:3000/api/graph | head -c 80
{"nodes":[{"id":"companies/composio","label":"Composio","type":"company","text":
```

### Blocking concerns

None.
