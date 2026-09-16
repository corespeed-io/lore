# `@corespeed/lore-sdk`

Typed TypeScript client for Lore's stable `/api/v1` API and `/readyz` probe. Its
contract is generated from Lore's canonical OpenAPI document; its runtime owns Actor
authentication, Workspace scoping, opaque pagination, optimistic concurrency,
idempotency, bounded error handling, durable Episode recording, and RLS-filtered
Observation evidence reads. The Workspace client also exposes exact-revision Code
search, bounded `queryCodeDependencies` callers/callees reads, and typed Proposal
Code Evidence anchors copied only after human acceptance.
`workspace.retrieveContext(...)` performs the same bounded joint retrieval through
one Workspace-scoped request, with Code pinned to an explicit repository key and
full commit OID. V2 keeps citation-local freshness separate from bounded contextual
impact over exact-revision direct dependencies.

The frontend, CLI, and external MCP adapter use this client against the same HTTP
and OpenAPI contract. In the frontend, SWR hooks call domain adapters, which use
`src/shared/browser/sdk.ts` to configure the SDK with same-origin browser
credentials, `timeoutMs: null`, and an `onRequest` logging observer. Browser requests
have no SDK deadline, preserving long-running reads and writes; caller
`AbortSignal` cancellation still applies. The SDK uses its native transport;
frontend code does not supply a fetch wrapper. Browser Memory types alias the
generated SDK types, while server Zod schemas supply validation and OpenAPI.

Other clients default to a 30-second total request deadline, including response
reading. Set `timeoutMs` to an integer from 1 through 300,000 milliseconds to change
it, or explicitly pass `null` to disable it.

The Workspace client also exposes human Actor reads, Agent lifecycle/grant/credential
administration, and Workspace export/import. These methods preserve server-side
human authorization and do not add corresponding CLI commands or MCP tools.
Workspace exports read the complete archive under the server's record-count limits;
they are exempt from the ordinary 128 MiB success-response cap. Error responses
remain capped at 64 KiB, and any configured request deadline still applies.
The development Graph scale benchmark uses a separate, production-disabled text
endpoint to measure decoded UTF-8 payload bytes; it is outside this public SDK contract.

See the repository's [developer integration guide](https://github.com/corespeed-io/lore/blob/main/docs/developer-integration.md)
for usage and security guidance.
