# Joint Memory + Code real-Git v2 baseline

Date: 2026-08-14  
Revision: `joint-memory-code-real-git-v2`  
Reader: OpenAI `gpt-5.6-sol`, low reasoning effort  
Decision: **pass**

## Change under test

V2 makes `citedDeclarationChunkOrdinal` part of the immutable Memory Code
Evidence locator. The value is resolved from the authorized Artifact rather than
accepted from the caller and is preserved across:

- direct Memory citation;
- owner-private Proposal Code Evidence;
- human acceptance into canonical Memory Code Evidence;
- RLS equality checks and immutable-anchor protection;
- HTTP/OpenAPI, TypeScript SDK, Python SDK, MCP output, and Proposal UI;
- grouped Memory + Code reader evidence.

Revalidation treats `declarationKey + declarationChunkOrdinal` as a changed-target
identity only when the cited and target declaration partitions have the same
non-zero chunk count. Exact content remains stronger. A changed partition count
returns `ambiguous` instead of binding the old ordinal to unrelated content.

## Commands

```bash
bun run evaluate:joint-memory-code:real \
  --database /tmp/lore-joint-memory-code-real-v2.PROTOTYPE.LuAhy0 \
  --no-reader --strict

bun run evaluate:joint-memory-code:real \
  --database /tmp/lore-joint-memory-code-real-v2.PROTOTYPE.LuAhy0 \
  --reader-provider codex \
  --model gpt-5.6-sol \
  --strict
```

The scratch database was created from the updated greenfield baseline and indexed
the same exact trusted Git commits as v1. Both manifests contain 326 entries; the
base generation contains 4,173 Artifacts and the target contains 4,177.

## Ablation result

| Variant | Route | Memory recall | Code recall | Anchor state | Reader pass | Avg reader evidence chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Code only | 50.0% | 50.0% | 83.3% | 0% | not run | 2,766 |
| Always-on Memory + Code | 50.0% | 100% | 83.3% | 0% | 66.7% (4/6) | 2,900 |
| Selective + typed revalidation | 100% | 100% | 100% | 100% | 100% (6/6) | 3,176 |

The fixed reader remained ephemeral, empty-directory, and read-only. It received
only the bounded evidence prompt under a strict JSON output schema.

## Adversarial result

Two integration cases distinguish safe and unsafe ordinal use:

1. A stable multi-chunk declaration with one changed chunk resolves to the exact
   target Artifact and reports `changed`.
2. Inserting one chunk before the cited chunk changes the declaration partition;
   revalidation reports `ambiguous` with no validated Artifact.

The real `createMemoryModule.propose` citation exercises the second class without
synthetic help: its declaration contracts from three chunks to two, while the
historical citation records ordinal 2. V2 persists that ordinal but correctly
keeps the anchor `ambiguous`. GPT-5.6 answers from independently retrieved current
Code, states the ambiguity, and cites Memory, Code, and the typed anchor.

## Remaining falsification

- Equal-count structural reorder can still preserve the count while changing
  ordinal meaning; add sequence/context fingerprints or a conservative alignment
  proof before treating that class as exact.
- The corpus remains six hand-authored cases from one adjacent commit pair.
- Required-term and citation-shape scoring is deterministic, not an independent
  entailment judge.
- Production Postgres latency, code dense retrieval, broader dependency traversal,
  and the public joint MCP orchestration surface remain unevaluated.
