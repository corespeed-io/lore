# Contributing to Lore

> **Using an AI coding agent?** [AGENTS.md](../AGENTS.md) is the single source of truth for agent instructions. `CLAUDE.md` and `.github/copilot-instructions.md` are thin pointers to it — **edit only AGENTS.md** so the tools never drift.

## Development setup

Use Bun 1.3.14 or newer, Node.js 24 LTS, and Postgres with pgvector.
`bun.lock` is the only dependency lockfile; do not add `package-lock.json`,
`pnpm-lock.yaml`, or `yarn.lock`.

```bash
git clone https://github.com/corespeed-io/lore.git
cd lore
bun install --frozen-lockfile
bun run dev
```

The app runs at http://localhost:3000. Environment variables are loaded from `.env` (or `.env.local` for local overrides).

## Development commands

```bash
bun run dev        # Start dev server with hot reload
bun run lint       # Check code style with Biome
bun run format     # Auto-format code with Biome
bun run typecheck  # Type-check with TypeScript
bun run test       # Run tests with Vitest
bun run build      # Build for production
bun run preview:cloudflare # Preview the Workers build through workerd
```

All core commands must pass before opening a pull request; changes to deployment or
server runtime code must also pass the
[OpenNext/Wrangler dry run](../docs/reference.md#verify-changes).

```bash
bun run typecheck && bun run lint && bun run test && bun run build
```

## Code conventions

### Style

- **Biome** for formatting and linting. Run `bun run format` to fix most issues automatically.
- **TypeScript** with strict mode enabled. No `any` types without justification.
- Prefer Server Components until browser state or effects are required.
- **Kebab-case** for file names; PascalCase for React components.

### Memory and tenant safety

Lore owns its Memory write and retrieval paths. All tenant-owned data must carry a
Workspace, ownership, and scope from the first migration. When adding a feature:

- ✓ Write through the Memory module and test observable behavior at its interface
- ✓ Apply Workspace and private visibility filters before top-k retrieval
- ✓ Add positive and negative RLS tests for every tenant-owned table
- ✗ No unrestricted request-path service role or caller-trusted ownership fields
- ✗ No generic upstream-tool passthrough

See `AGENTS.md` and `CONTEXT.md` for the complete invariants and vocabulary.

### Testing

- Tests live in `tests/` and follow the naming convention `<feature>.test.ts`.
- Use `vitest` for unit and integration tests.
- Aim for >80% coverage on new logic.
- Run `bun run test` before committing.

### Commits

- Use clear, concise commit messages.
- Reference issues or PRs when relevant.
- Squash work-in-progress commits before pushing.

Example:
```
feat(memory): add source metadata

- Persist source metadata through the Memory module
- Enforce Workspace and private-scope visibility with RLS
- Add positive and negative isolation tests
```

## Questions?

Open an issue or start a discussion in the repo. We're here to help!
