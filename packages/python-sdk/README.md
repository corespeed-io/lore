# `corespeed-lore-sdk`

Typed, dependency-light Python client for Lore's stable `/api/v1` API. The
public contract is generated from Lore's canonical OpenAPI document; the runtime
owns Actor authentication, Workspace scoping, opaque pagination, optimistic
concurrency, idempotency, bounded responses, and redirect-safe error handling.
It also exposes durable Episode recording and RLS-filtered Observation evidence
reads, exact-revision Code search, and bounded `query_code_dependencies`
callers/callees reads. Proposal inputs may carry typed Code Evidence anchors that
become canonical Memory evidence only after human acceptance. Python 3.12 or newer
is required; Python 3.14 is the recommended runtime.
Use `workspace.retrieve_context(...)` for one bounded joint Memory/Code request;
Code retrieval requires an explicit repository key and full commit OID. V2 keeps
citation-local freshness separate from bounded contextual impact over
exact-revision direct dependencies.

Human-authenticated Workspace clients also expose the current human Actor, Agent
lifecycle, Workspace grants, credentials, and Workspace export/import. These
methods reuse the same Workspace header and error handling as Memory operations.
For example, `workspace.create_agent("Research assistant", permission="read")`
creates an Agent and `workspace.export_workspace()` returns the typed archive.
Successful exports have no SDK byte cap so server-valid archives can be returned
in full; other successful responses retain the 128 MiB cap, and all HTTP errors
retain the 64 KiB cap. Exports still use the configured timeout and strict UTF-8
JSON decoding.
Pass the complete generated `ImportWorkspaceInput`, including the explicit
`ownerMap`, to `workspace.import_workspace(...)`; set `"dryRun": True` in that input
to validate an import without applying it.

See the repository's [developer integration guide](https://github.com/corespeed-io/lore/blob/main/docs/developer-integration.md)
for usage and security guidance.
