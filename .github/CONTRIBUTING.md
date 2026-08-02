# Contributing to Lore

> **Using an AI coding agent?** [AGENTS.md](../AGENTS.md) is the single source of truth for agent instructions. `CLAUDE.md` and `.github/copilot-instructions.md` are thin pointers to it — **edit only AGENTS.md** so the tools never drift.

## Development setup

```bash
git clone https://github.com/corespeed-io/lore.git
cd lore
npm install
npm run dev
```

The app runs at http://localhost:3000. Environment variables are loaded from `.env` (or `.env.local` for local overrides).

## Development commands

```bash
npm run dev        # Start dev server with hot reload
npm run lint       # Check code style with Biome
npm run format     # Auto-format code with Biome
npm run typecheck  # Type-check with TypeScript
npm test           # Run tests with Vitest
npm run build      # Build for production
```

All commands must pass before opening a pull request:
```bash
npm run typecheck && npm run lint && npm test && npm run build
```

## Code conventions

### Style

- **Biome** for formatting and linting. Run `npm run format` to fix most issues automatically.
- **TypeScript** with strict mode enabled. No `any` types without justification.
- **Functional components** — use React hooks.
- **Kebab-case** for file names; PascalCase for React components.

### The console reads; agents write

Lore stores its own pages and memories, so "nothing writes" is not the rule. The
rule is that **the browser console only ever holds the reading credential**:
`/api/call` passes `"read"` into the dispatcher, which decides from each tool's
own declared `access`. When adding a feature:

- ✓ Reach for a `read` tool from the console; add a `write` tool to the agent
  surface (`POST /api/mcp`, bearer `BRAIN_WRITE_TOKEN`)
- ✗ Never widen a tool from `write` to `read` to make a console feature work

See [SECURITY.md](SECURITY.md) for the full model.

### Testing

- Tests live in `tests/` and follow the naming convention `<feature>.test.ts`.
- Use `vitest` for unit and integration tests.
- Aim for >80% coverage on new logic.
- Run `npm test` before committing.

### Adding a visualization module

1. Create `src/lib/viz/<name>.ts` exporting a mount function that returns a
   handle the caller can tear down — see `src/lib/viz/graph.ts` for the shape:

   ```typescript
   import type { GraphData } from "@/lib/types";

   export interface Instance {
     destroy(): void;
     highlight(ids: Set<string> | null): void;
   }

   export function mountName(el: HTMLElement, data: GraphData, opts: Opts): Instance {
     // Render with d3, canvas, or DOM APIs
   }
   ```

2. Import it directly in the view component and call `destroy()` on unmount —
   there is no registry to register with.

3. Write tests for the pure parts in `tests/viz-<name>.test.ts`.

### Commits

- Use clear, concise commit messages.
- Reference issues or PRs when relevant.
- Squash work-in-progress commits before pushing.

Example:
```
feat: add timeline visualization module

- Render entity activity by date using d3-time-scale
- Add viz-timeline.test.ts with 3 scenarios
- Update README with module walkthrough
```

## Known limitations / follow-ups

The following items are deferred post-v1:

1. **Timing-safe password comparison** — `password` auth mode compares in constant time. A constant-time compare would mitigate timing attacks (see `src/lib/auth.ts`). Note `password` mode isn't the recommended deployment posture — prefer `gateway` (a JWT- or secret-verified proxy), whose JWT is fully verified.

## Questions?

Open an issue or start a discussion in the repo. We're here to help!
