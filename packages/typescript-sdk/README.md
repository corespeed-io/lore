# `@corespeed/lore-sdk`

Typed TypeScript client for Lore's stable `/api/v1` Memory API. Its contract is
generated from Lore's canonical OpenAPI document; its runtime owns Actor
authentication, Workspace scoping, opaque pagination, optimistic concurrency,
idempotency, bounded error handling, durable Episode recording, and RLS-filtered
Observation evidence reads. The Workspace client also exposes exact-revision Code
search, bounded `queryCodeDependencies` callers/callees reads, and typed Proposal
Code Evidence anchors copied only after human acceptance.
`workspace.retrieveContext(...)` performs the same bounded joint retrieval through
one Workspace-scoped request, with Code pinned to an explicit repository key and
full commit OID. V2 keeps citation-local freshness separate from bounded contextual
impact over exact-revision direct dependencies.

See the repository's [developer integration guide](https://github.com/corespeed-io/lore/blob/main/docs/developer-integration.md)
for usage and security guidance.
