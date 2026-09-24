# Lore developer integration

Lore exposes its stable `/api/v1` contract through the TypeScript SDK and direct
HTTP access for clients in other languages.
The frontend, CLI, and external MCP adapter use the TypeScript SDK; deployment
readiness remains the stable `/readyz` probe. These packages do not introduce a
second authorization model or a tool-shaped
compatibility API. Each request still resolves an Actor, selects one Workspace, and
executes under Postgres RLS.

## Build and contract generation

Bun 1.4.2+ builds the packages and runs the CLI/MCP executables. The TypeScript
SDK exports standard ESM and declarations and remains usable by other compatible
hosts and browsers.

The canonical OpenAPI document is implemented by `src/server/openapi/document.ts` and served at
`/openapi.json`. The generator commits TypeScript types/runtime error codes and
CLI/MCP versions:

```bash
bun run sdk:generate
bun run sdk:check
bun run build:packages
```

`sdk:check` fails when the OpenAPI document and any generated artifact differ. The
handwritten SDK runtime wraps those types with the behavior OpenAPI alone cannot provide:
authentication, `x-lore-workspace-id`, opaque cursors, strong Memory ETags,
idempotency keys, bounded response reads, a default 30-second request deadline, and
safe error parsing. TypeScript `timeoutMs` is a total deadline spanning connection
and bounded response reading; CLI/MCP operators may set the same value with
`LORE_REQUEST_TIMEOUT_MS` from 1 through 300,000 milliseconds. Explicit
`timeoutMs: null` disables the SDK timeout. Omitting the option retains the
30-second default; caller cancellation still works when the deadline is disabled.

Ordinary success responses are capped at 128 MiB and error responses at 64 KiB.
Workspace exports read complete archives under the server's record-count limits,
without the ordinary success-response byte cap; the configured timeout still applies.

The frontend follows `SWR hook → domain client → TypeScript SDK → HTTP API`.
SWR owns cached remote state and mutations. Domain clients retain UI defaults;
`src/shared/browser/sdk.ts` supplies the same-origin base URL, browser credentials,
and an `onRequest` observer for request logs. It sets `timeoutMs: null` to preserve
the browser's existing ability to wait for long-running imports, exports, Graph
reads, and searches. API paths, Workspace headers,
serialization, parsing, cancellation, and error handling stay in the SDK. There
is no shared browser fetch wrapper. Browser Memory types alias the generated SDK
types; server Zod schemas remain the source for validation and OpenAPI components.

The development Graph scale benchmark is outside this public API contract. Its
isolated client directly reads text to measure the decoded UTF-8 payload including
whitespace, while SWR manages its remote state. The endpoint returns 404 in
production and is not exposed by the public SDK, CLI, or MCP adapter.

## Shared connection environment

The CLI and MCP process use the same variables. Their executable entrypoints
disable automatic `.env` loading; supply credentials in the process environment:

| Variable | Meaning |
| --- | --- |
| `LORE_URL` | Lore base URL; defaults to `http://127.0.0.1:3000` |
| `LORE_WORKSPACE_ID` | Workspace UUID for scoped commands and all MCP tools |
| `LORE_AGENT_TOKEN` | One-time Agent bearer credential |
| `LORE_BASIC_PASSWORD` | Password for a single-operator self-host deployment |
| `LORE_BASIC_USERNAME` | Optional Basic username; authentication never maps identity from it |
| `LORE_ACCESS_TOKEN` | Cloudflare Access gateway client token sent as `cf-access-token` |
| `LORE_ACCESS_CLIENT_ID` | Cloudflare Access gateway service-token client id |
| `LORE_ACCESS_CLIENT_SECRET` | Cloudflare Access gateway service-token client secret |
| `LORE_REQUEST_TIMEOUT_MS` | CLI/MCP total request deadline; defaults to `30000`, maximum `300000` |
| `LORE_ALLOW_INSECURE` | `1` or `true` to opt into authenticated non-loopback HTTP |

Configure at most one Lore Actor mechanism (`LORE_AGENT_TOKEN` or Basic) and at
most one Cloudflare Access gateway mechanism. They are separate layers: an Agent
behind Access normally needs both its Lore Agent token and the Access service-token
pair. A service token passes the Access gateway; it does not establish a Lore Actor.
Authenticated plain HTTP is refused
outside loopback unless `LORE_ALLOW_INSECURE` is explicit. Prefer HTTPS; the escape
hatch is for a trusted development network only. A service token requires both id
and secret. Access credentials must be visible ASCII, and a malformed one is reported
by its variable name without echoing the value. The origin-only
`cf-access-jwt-assertion` header is intentionally not a client option. This follows Cloudflare's documented
[client-token header](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
and [service-token headers](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

## TypeScript SDK

```ts
import { LoreClient } from "@corespeed/lore-sdk";

const lore = new LoreClient({
  baseUrl: process.env.LORE_URL ?? "http://127.0.0.1:3000",
  auth: { type: "agent", token: process.env.LORE_AGENT_TOKEN ?? "" },
});
const memories = lore.workspace(process.env.LORE_WORKSPACE_ID ?? "");

const episode = await memories.recordEpisode(
  {
    kind: "conversation",
    observations: [{ kind: "message", content: "The rollout starts Monday." }],
  },
  { idempotencyKey: "rollout-episode-1" },
);

const created = await memories.remember({
  content: "The rollout starts Monday.",
  scope: "shared",
});

await memories.proposeMemory(
  {
    kind: "update",
    targetMemoryId: created.id,
    expectedVersion: created.version,
    content: "The rollout starts after human approval.",
    evidenceObservationIds: [episode.observations[0].id],
    codeEvidence: [{ artifactId: "CODE_ARTIFACT_UUID", relationship: "implements" }],
  },
  { idempotencyKey: "rollout-proposal-1" },
);

const dependencies = await memories.queryCodeDependencies({
  repositoryKey: "corespeed/lore",
  commitOid: "0123456789abcdef0123456789abcdef01234567",
  direction: "callers",
  symbol: "createMemoryModule",
  limit: 50,
});
```

The Workspace client also provides `listEpisodes`, `recordEpisode`, `getEpisode`,
bounded `getObservations`, and `forgetEpisode`, plus `listMemoryProposals`,
`proposeMemory`, and `reviewMemoryProposal` alongside the canonical Memory methods.
An Observation is durable raw evidence, not searchable Memory. Observation evidence is
resolved again under the reviewing human's current RLS visibility. Proposal Code
Evidence is instead frozen as an exact commit/path/symbol/digest anchor at submission
and copied transactionally onto the accepted Memory without re-resolution. All three
evidence categories share one 50-item limit.
Episode recording, Proposal submission, and direct Memory mutation methods create
a replay-safe idempotency key unless the caller supplies one; a supplied key must be
1 to 128 visible ASCII characters, as the API requires. Direct update/forget and update
proposals require the current positive Memory version. Proposal listing and review
require a human Actor; a write-granted Agent may submit a proposal but cannot accept
it. Review is status-idempotent: repeating the same decision has no additional
effect, while the opposite decision returns a conflict.

For human administration, the Workspace client also provides
`getCurrentHumanActor`, Agent list/create/update/delete methods, grant and
credential management, and `exportWorkspace`/`importWorkspace`. These methods use
the same Actor and Workspace authorization as the HTTP API. Their availability in
the SDK does not add human administration commands to the CLI or tools to MCP.

## Host retrieval policy

The TypeScript SDK exports the pure `retrieval-grounding-v5` gate as
`planRetrievalGrounding`, with its `RetrievalGroundingReasonCode` union. Call it with the original question and trusted repository
context: `exact` for a selected repository and
full commit OID, `configured` when the repository has no selected commit, or
`none` when no repository is registered.

Apply the plan before model tool selection:

- If `shouldClarify` is true, return a clarification without a model turn. Use
  `reasonCode` to render it in the user's language: `missing_commit_oid` or
  `repository_unconfigured`. The supplied `clarification` is an English default.
- If `shouldRetrieve` is true, perform the authorized `retrieveContext` call
  and pass its bounded evidence packet to the model.
- Otherwise, `mode=off` skips retrieval; `mode=auto` leaves retrieval optional.

The gate determines whether grounding is required. The compound retrieval API
then chooses the Memory and Code routes under the authenticated Workspace. A
missing exact Code revision cannot be replaced with a Memory search. See the
[MCP host guidance](../packages/mcp/README.md) for specialist follow-up tools.

## CLI

After `bun run build:packages`, run:

```bash
bun --no-env-file packages/cli/dist/bin.js workspace list
bun --no-env-file packages/cli/dist/bin.js memory list --limit 25
printf %s "release date" | bun --no-env-file packages/cli/dist/bin.js memory search --stdin
bun --no-env-file packages/cli/dist/bin.js memory get MEMORY_UUID
printf %s "fact" | bun --no-env-file packages/cli/dist/bin.js memory remember --stdin \
  --scope private --idempotency-key fact-1
printf %s "suggested fact" | bun --no-env-file packages/cli/dist/bin.js memory propose create \
  --stdin --scope private \
  --code-evidence CODE_ARTIFACT_UUID:implements --idempotency-key proposal-1
printf '%s' '{"kind":"conversation","observations":[{"kind":"message","content":"raw evidence"}]}' \
  | bun --no-env-file packages/cli/dist/bin.js episode record --stdin --idempotency-key episode-1
bun --no-env-file packages/cli/dist/bin.js episode list --scope private
bun --no-env-file packages/cli/dist/bin.js code dependencies callers \
  --repository corespeed/lore --commit FULL_COMMIT_OID \
  --symbol createMemoryModule --limit 50
bun --no-env-file packages/cli/dist/bin.js memory propose update MEMORY_UUID --version 2 \
  --content "suggested replacement" --observation-evidence OBSERVATION_UUID \
  --idempotency-key proposal-update-1
printf %s "new fact" | bun --no-env-file packages/cli/dist/bin.js memory update MEMORY_UUID \
  --version 2 --stdin --idempotency-key fact-update-1
bun --no-env-file packages/cli/dist/bin.js memory forget MEMORY_UUID --version 3 \
  --idempotency-key fact-forget-1
bun --no-env-file packages/cli/dist/bin.js capabilities
bun --no-env-file packages/cli/dist/bin.js readiness
```

Commands emit JSON to stdout. Diagnostics go to stderr; API failures exit `1` and
configuration/usage failures exit `2`. Credentials are environment-only. Use
`--stdin` for private query/content so it does not enter shell history or the process
list; `--metadata JSON` remains an argv convenience and should not carry secrets.
Reuse one `--idempotency-key` when retrying an unknown mutation outcome.

## External MCP adapter

The adapter uses the official TypeScript MCP server SDK and its stdio compatibility
helper. It is deliberately external to the Lore application and Portable Core.
Start it with the shared environment above:

```bash
bun --no-env-file packages/mcp/dist/bin.js
```

It exposes:

- `lore_list`, `lore_search`, and `lore_get` as read-only tools;
- `lore_observe` to durably record a bounded, non-canonical Episode;
- `lore_remember` as a non-destructive mutation tool;
- `lore_propose` as a non-destructive submission for explicit human review;
- `lore_update` as destructive because it may replace content, metadata, or visibility;
- `lore_forget` as an explicitly destructive tool.
- `lore_retrieve_context` as the read-only joint Memory/Code orchestration tool;
- `lore_code_search`, `lore_code_dependencies`, and `lore_code_index_status` as
  bounded exact-revision Code reads;
- `lore_code_index` to queue one exact commit from an operator-configured source;
- `lore_code_evidence_list`, `lore_code_evidence_cite`, and
  `lore_code_evidence_revalidate` as the separate typed Memory/Code evidence family.

The Workspace id is process configuration, not tool input, so a model cannot ask
the adapter to cross a Workspace boundary. Returned Memory objects omit internal
top-level Workspace, owner User, and creating Agent ids. Lore still applies the credential's
read/write grant and RLS to every operation. The adapter neither stores nor logs
the credential, Memory content, or query text.

`lore_retrieve_context` accepts one question plus optional `repositoryKey` and
full 40/64-character `commitOid`; those two Code selectors must be supplied
together. `route=auto` applies Lore's versioned deterministic route policy, while
an agent that already knows the question needs both stores may request
`route=both`. Optional `memoryQuery` and `codeQuery` let the calling agent supply
channel-specific search terms without changing the original routing question;
the receipt records the exact queries used. The server performs authorized Memory
retrieval, exact-revision Code retrieval, and side-effect-free citation assessment
in one request. For a routed change question, `joint-memory-code-v2` also compares
bounded direct dependencies for up to five resolved citations, with at most 25
edges per citation. Dependency targets are fingerprinted across their complete
logical declaration chunk sequence. `unknown` and `possibly_affected` are explicit
outcomes when a historical generation, target resolution, or complete bounded
traversal is unavailable; they do not mean unchanged. Its response
keeps `memories`, `code`, `anchors`, `conflicts`, and the retrieval `receipt`
separate. It does not write Memory or persisted Code Evidence state.

One Memory is a bounded canonical knowledge record, not a document container. Keep
it at or below the recommended 8,000 Unicode characters; Lore rejects content over
32,000 characters or 64 derived chunks across direct writes, Proposals, and
imports. Record longer source material as `document_fragment` Observations in a
document Episode, then cite that evidence from a reviewed Proposal.

Lore derives non-overlapping chunks of at most 1,200 Unicode code points. They
preserve formatting and reconstruct the Memory exactly while preferring structural
boundaries; `lore-memory-chunking-v2` is exposed by `/api/v1/capabilities`.
Consumers should use returned evidence and the bounded neighbor policy rather than
assuming whitespace-normalized chunks or adding hidden overlap.

Self-host operators enable indexing by setting a server-side registry, for example:

```bash
export LORE_CODE_REPOSITORIES='{"corespeed/lore":{"displayName":"Lore","repositoryPath":"/absolute/path/to/lore","workspaceIds":["<workspace-uuid>"]}}'
```

`workspaceIds` names the Workspaces whose Actors may index and read that
repository. An entry without it is served only when `AUTH_MODE` is `password` or
`none` (a single operator); in `proxy` mode it is ignored with a server-side
warning, so a multi-user deployment must bind every repository. A Workspace outside
the binding gets the same "not configured" error as an unknown key. The maintenance
worker reads the same variable and resolves paths from it rather than from the job.

The model supplies `repositoryKey` and a full 40/64-character commit OID. It cannot
supply or discover `repositoryPath`; an empty registry disables enqueue. Native
Git and AST work runs in the Bun maintenance worker, never in the MCP or
Cloudflare request bundle.

`lore_code_dependencies` accepts exactly one `symbol` or `path` plus
`direction=callers|callees`. Results are capped at 200 and report `truncated`.
Static targets remain explicitly `resolved`, `ambiguous`, or `unresolved`; clients
must not treat an unresolved target as proof that no runtime dependency exists.

MCP output has an independent 128,000-character structured-output ceiling. List
uses bounded content previews, search returns bounded evidence without duplicating
full Memory content, and detail/mutation responses mark `contentTruncated` or
`metadataTruncated` when a value cannot safely fit. `lore_code_search`,
`lore_retrieve_context`, and `lore_code_dependencies` share the ceiling across the
items one call returns: each excerpt gets an equal share of the characters left,
and items that still cannot fit are dropped from the end and reported with
`truncated: true`, so a request within the tool limits is never rejected for size.
Metadata inputs have one bound, the same 100,000 serialized characters the HTTP
Memory schemas enforce with Zod JSON validation; neither surface limits nesting
depth or value count separately.

All five mutation tools accept an optional `idempotencyKey` of 1 to 128 visible
ASCII characters, the HTTP `Idempotency-Key` rule; the adapter and SDK reject any
other key before sending the request. A caller retrying an operation after losing
the response must reuse the same key; omitting it creates a fresh operation.

AutoDream is not part of this adapter. A future AutoDream process must remain an
explicit opt-in extension outside Portable Core; it may record Observations and
submit a Memory Proposal, but must not silently persist summaries, merges, or
insights into Memory core. Observation content remains until an explicit Episode
forget. Pending and reviewed Proposal content expires after 30 days.
