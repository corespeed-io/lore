## What & why

<!-- What does this change and why? Link any related issue (#123). -->

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun run test` passes
- [ ] `bun run build` passes
- [ ] Cloudflare adapter dry-run passes when deployment/runtime code changed
- [ ] Tenant-owned data is covered by RLS and negative isolation tests
- [ ] Retrieval filters Workspace/private visibility before ranking
- [ ] No generic upstream-tool passthrough or unrestricted request-path service role
- [ ] Updated `AGENTS.md` if I changed behavior agents rely on (commands, flows, gotchas)
- [ ] Updated `CONTEXT.md` if I changed canonical domain language
