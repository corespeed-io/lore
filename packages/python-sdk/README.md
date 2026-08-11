# `corespeed-lore-sdk`

Typed, dependency-light Python client for Lore's stable `/api/v1` Memory API. The
public contract is generated from Lore's canonical OpenAPI document; the runtime
owns Actor authentication, Workspace scoping, opaque pagination, optimistic
concurrency, idempotency, bounded responses, and redirect-safe error handling.
It also exposes durable Episode recording and RLS-filtered Observation evidence
reads. Python 3.12 or newer is required; Python 3.14 is the recommended runtime.

See the repository's [developer integration guide](https://github.com/corespeed-io/lore/blob/main/docs/developer-integration.md)
for usage and security guidance.
