# `@corespeed/lore-sdk`

Typed TypeScript client for Lore's stable `/api/v1` Memory API. Its contract is
generated from Lore's canonical OpenAPI document; its runtime owns Actor
authentication, Workspace scoping, opaque pagination, optimistic concurrency,
idempotency, bounded error handling, durable Episode recording, and RLS-filtered
Observation evidence reads.

See the repository's [developer integration guide](https://github.com/corespeed-io/lore/blob/main/docs/developer-integration.md)
for usage and security guidance.
