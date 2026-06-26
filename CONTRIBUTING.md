# Contributing to Lore

> **Using an AI coding agent?** [AGENTS.md](./AGENTS.md) is the single source of truth for agent instructions. `CLAUDE.md`, `GEMINI.md`, and `.github/copilot-instructions.md` are thin pointers to it — **edit only AGENTS.md** so the tools never drift.

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

### Read-only guarantee

This app **reads from gbrain and renders graphs**; it does not mutate user data. No write tools or database mutations are allowed—all MCP tool calls are read-only. When adding a feature:

- ✓ Query gbrain, search, call analysis tools
- ✗ No mutation tools, no database writes, no destructive operations

This is enforced by code review.

### Testing

- Tests live in `tests/` and follow the naming convention `<feature>.test.ts`.
- Use `vitest` for unit and integration tests.
- Aim for >80% coverage on new logic.
- Run `npm test` before committing.

### Adding a visualization module

1. Create a new file `src/lib/viz/<name>.ts` with a `mount` function:
   ```typescript
   import type { GraphData, VizOptions } from "@/lib/types";
   
   export function mount<Name>(
     element: HTMLElement,
     data: GraphData,
     options: VizOptions,
   ): void {
     // Render visualization using d3, canvas, or DOM APIs
   }
   ```

2. Type your viz in the registry. Update `src/lib/types.ts` if needed.

3. Import and call `mount` in the appropriate view component.

4. Write tests for the viz logic in `tests/viz-<name>.test.ts`.

5. Update the README's "Adding a visualization module" section if the process differs.

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

1. **Timing-safe password comparison** — `password` auth mode compares with strict equality (`===`). A constant-time compare would mitigate timing attacks (see `src/lib/auth.ts`). Note `password` mode isn't the recommended deployment posture — prefer `proxy` (Cloudflare Access), whose JWT is fully verified.

## Questions?

Open an issue or start a discussion in the repo. We're here to help!
