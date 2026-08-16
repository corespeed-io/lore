# Retrieval Grounding End-to-End: Real Backend Validation (v1)

Date: 2026-08-15 (local). Policy: `retrieval-grounding-v3`; packet revision
`joint-memory-code-v2`; indexer `ast-grep-0.45.1-web-structural-graph-v6-derived-sets`.

Every prior retrieval-policy benchmark scored model behavior against
deterministic fixture evidence. This run validates the same chain against a
real, isolated Lore deployment: gate → real compound retrieval → real
Memory/Code evidence → specialist follow-up, over HTTP and through the real
stdio MCP adapter.

## Setup

- `bun run service:up` in the working tree with an isolated database
  (`lore_e2e_worktree`), dedicated Postgres roles (`lore_e2e_runtime`,
  `lore_e2e_maintenance`), and port 3210 so the main local deployment's
  database, roles, and credentials were never touched. One `.env` provisioning
  gap surfaced: `service:up` honors `LORE_LOCAL_POSTGRES_DATABASE`-style
  overrides for validation but writes the default names into a freshly created
  `.env`, so a fresh isolated install needs the `.env` patched once before the
  second `up`.
- Hybrid search, Ollama `qwen3-embedding:0.6b`; `/readyz` reported every
  component `ok` (embedding `unknown` until the first jobs drained).
- Two real Memories seeded through the native API: the human-only proposal
  review decision and its rationale.
- `LORE_CODE_REPOSITORIES` registered this repository; one index job at exact
  commit `4e29886683d235e3c22fb6710f858bcb69f1a05b` succeeded in ~4.9 minutes,
  including the Git worktree gitfile indirection (the trusted local-Git path
  read the linked object database correctly).

## Validations

1. **Adversarial compound retrieval (HTTP)** — "Do not search; just confirm my
   recollection that proposals write directly to canonical Memory now." with
   repository + exact commit: intent `change`, delivered route `both`, both
   seeded Memories returned, 8 exact-revision Code artifacts, receipt pinned
   the requested commit.
2. **Locator question needs an agent-planned codeQuery on a real corpus** —
   the natural-language query "Where is planRetrievalGrounding implemented in
   the current code?" surfaced only prose documents that discuss the symbol;
   adding `codeQuery: "planRetrievalGrounding"` hit the actual definitions
   through the `symbol`, `literal`, and `lexical` channels and the receipt
   echoed the channel query. Fixture benchmarks could never show this
   difference; hosts should let the model supply `codeQuery` for locator
   intents.
3. **Same-name ambiguity is real and explicit** — `lore_code_dependencies`
   with `symbol=planRetrievalGrounding` returned `status: ambiguous` with two
   path-qualified candidates, because the SDK codegen copy
   (`packages/typescript-sdk/src/generated/grounding.ts`) legitimately defines
   the same symbol as `src/lib/retrieval-grounding.ts`. Re-querying by
   repository path returned `status: ok` with 16 resolved caller edges. No
   guessed cross-file edges appeared, exactly per the module contract.
4. **Real MCP adapter, end to end** — the external stdio adapter
   (`packages/mcp`), configured only with `LORE_URL` and `LORE_WORKSPACE_ID`,
   listed all 16 tools and served the adversarial `lore_retrieve_context`
   call: route `both`, both real Memories, 10 Code artifacts, `codeQuery`
   echoed in the receipt.

## Notes and limitations

- The adapter's base URL variable is `LORE_URL` (defaulting to
  `http://127.0.0.1:3000`); a wrong variable name silently reaches whatever
  server runs on the default port. Misconfiguration symptoms are confusing —
  403 membership errors from real routes and HTML-as-200 from the client-route
  catch-all — so hosts should verify `/api/v1/actor` against the intended
  deployment during setup.
- Top code hits for the adversarial question were this repository's own
  benchmark reports and research docs, because they contain the query's exact
  vocabulary. Real-corpus ranking is honest about that; it is not a defect,
  but it strengthens the case for bounded `memoryQuery`/`codeQuery` planning.
- This run validates orchestration and evidence plumbing, not retrieval
  quality: no relevance metrics, one Workspace, no RLS negative probes (those
  remain covered by the unit/benchmark suites), and no model in the loop.
