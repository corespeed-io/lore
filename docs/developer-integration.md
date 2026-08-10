# Lore developer integration

Lore exposes its stable `/api/v1` Memory contract to the TypeScript SDK, Python SDK,
CLI, and external MCP adapter; deployment readiness remains the stable `/readyz`
probe. These packages do not introduce a second authorization model or a tool-shaped
compatibility API. Each request still resolves an Actor, selects one Workspace, and
executes under Postgres RLS.

## Build and contract generation

The canonical OpenAPI document is implemented by `src/lib/openapi.ts` and served at
`/openapi.json`. The generator commits TypeScript types/runtime error codes, Python
`TypedDict` contracts/runtime error codes, and CLI/MCP versions:

```bash
bun run sdk:generate
bun run sdk:check
bun run build:packages
```

`sdk:check` fails when the OpenAPI document and any generated artifact differ. The
handwritten SDK runtimes wrap those types with the behavior OpenAPI alone cannot provide:
authentication, `x-lore-workspace-id`, opaque cursors, strong Memory ETags,
idempotency keys, bounded response reads, a default 30-second request deadline, and
safe error parsing. TypeScript `timeoutMs` is a total deadline spanning connection
and bounded response reading; CLI/MCP operators may set the same value with
`LORE_REQUEST_TIMEOUT_MS` from 1 through 300,000 milliseconds. Python `timeout` is
passed to `urllib` as a socket-operation timeout and must be greater than 0 and at
most 300 seconds; it is not a total request deadline.

## Shared connection environment

The CLI and MCP process use the same variables:

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
and secret. The origin-only `cf-access-jwt-assertion` header is intentionally not a
client option. This follows Cloudflare's documented
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
  },
  { idempotencyKey: "rollout-proposal-1" },
);
```

The Workspace client also provides `listMemoryProposals`, `proposeMemory`, and
`reviewMemoryProposal` alongside `capabilities`, `graph`, `listMemories`,
`searchMemories`, `remember`, `getMemory`, `updateMemory`, and `forgetMemory`.
Proposal submission and direct Memory mutation methods create a replay-safe
idempotency key unless the caller supplies one. Direct update/forget and update
proposals require the current positive Memory version. Proposal listing and review
require a human Actor; a write-granted Agent may submit a proposal but cannot accept
it. Review is status-idempotent: repeating the same decision has no additional
effect, while the opposite decision returns a conflict.

## Python SDK

Build/install the package with an ordinary Python packaging frontend, or install it
directly from the checkout:

```bash
python3 -m pip install ./packages/python-sdk
```

```py
import os
from corespeed_lore import LoreClient

lore = LoreClient(
    os.environ.get("LORE_URL", "http://127.0.0.1:3000"),
    agent_token=os.environ["LORE_AGENT_TOKEN"],
)
memories = lore.workspace(os.environ["LORE_WORKSPACE_ID"])

created = memories.remember(
    "The rollout starts Monday.",
    scope="shared",
    idempotency_key="rollout-note-1",
)
memories.update_memory(
    created["id"],
    expected_version=created["version"],
    content="The rollout starts Tuesday.",
    idempotency_key="rollout-note-update-1",
)
memories.propose_memory(
    {
        "kind": "create",
        "content": "Suggested note awaiting human review.",
        "scope": "private",
    },
    idempotency_key="suggested-note-1",
)
```

The dependency-light synchronous client provides the same core Workspace/Memory,
readiness, graph, pagination, strong-version, and replay-safe mutation behavior as
the TypeScript client. It requires Python 3.12+; CI covers the minimum and current
stable Python 3.14 release.

## CLI

After `bun run build:packages`, run:

```bash
node packages/cli/dist/bin.js workspace list
node packages/cli/dist/bin.js memory list --limit 25
printf %s "release date" | node packages/cli/dist/bin.js memory search --stdin
node packages/cli/dist/bin.js memory get MEMORY_UUID
printf %s "fact" | node packages/cli/dist/bin.js memory remember --stdin \
  --scope private --idempotency-key fact-1
printf %s "suggested fact" | node packages/cli/dist/bin.js memory propose create \
  --stdin --scope private --idempotency-key proposal-1
node packages/cli/dist/bin.js memory propose update MEMORY_UUID --version 2 \
  --content "suggested replacement" --evidence EVIDENCE_MEMORY_UUID \
  --idempotency-key proposal-update-1
printf %s "new fact" | node packages/cli/dist/bin.js memory update MEMORY_UUID \
  --version 2 --stdin --idempotency-key fact-update-1
node packages/cli/dist/bin.js memory forget MEMORY_UUID --version 3 \
  --idempotency-key fact-forget-1
node packages/cli/dist/bin.js capabilities
node packages/cli/dist/bin.js readiness
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
node packages/mcp/dist/bin.js
```

It exposes:

- `lore_list`, `lore_search`, and `lore_get` as read-only tools;
- `lore_remember` as a non-destructive mutation tool;
- `lore_propose` as a non-destructive submission for explicit human review;
- `lore_update` as destructive because it may replace content, metadata, or visibility;
- `lore_forget` as an explicitly destructive tool.

The Workspace id is process configuration, not tool input, so a model cannot ask
the adapter to cross a Workspace boundary. Returned Memory objects omit internal
top-level Workspace, owner User, and creating Agent ids. Lore still applies the credential's
read/write grant and RLS to every operation. The adapter neither stores nor logs
the credential, Memory content, or query text.

MCP output has an independent 128,000-character structured-output ceiling. List
uses bounded content previews, search returns bounded evidence without duplicating
full Memory content, and detail/mutation responses mark `contentTruncated` or
`metadataTruncated` when a value cannot safely fit. Metadata inputs retain the
Portable Core's 100,000-character, 32-level, and 10,000-value limits.

All four mutation tools accept an optional `idempotencyKey`. A caller retrying an
operation after losing the response must reuse the same key; omitting it creates a
fresh operation.

AutoDream is not part of this adapter. A future AutoDream process must remain an
explicit opt-in extension outside Portable Core; it may submit a Memory Proposal,
but must not silently persist summaries, merges, or insights into Memory core.
