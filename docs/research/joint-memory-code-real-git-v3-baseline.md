# Joint Memory + Code real-Git v3 baseline

Date: 2026-08-14  
Revision: `joint-memory-code-real-git-v3`  
Reader: OpenAI `gpt-5.6-sol`, low reasoning effort  
Decision: **pass**

## Change under test

V3 closes the equal-count structural-reorder gap in declaration-chunk
revalidation. Every declaration citation now freezes
`citedDeclarationContextSha256`, calculated as:

```text
SHA256(concat(declaration chunk content digests in ordinal order,
              replacing the cited Artifact digest with "*"))
```

All non-target chunk digests and the target ordinal therefore participate in one
immutable, unambiguous sequence fingerprint. Revalidation may bind changed content
by `declarationKey + declarationChunkOrdinal` only when the target declaration
reproduces that fingerprint. Exact content remains stronger. Count drift,
equal-count reorder, balanced insertion/deletion, or replacement outside the cited
chunk returns `ambiguous` with no validated Artifact.

The value is server-resolved and preserved across direct citation, owner-private
Proposal Code Evidence, human acceptance, immutable-anchor protection, RLS equality
checks, HTTP/OpenAPI, both SDKs, MCP output, Proposal UI, and grouped reader evidence.
Canonical Code Evidence insertion RLS also verifies every live Artifact locator
field and digest instead of merely accepting an active generation identity.

## Commands

```bash
bun run evaluate:joint-memory-code:real -- \
  --database /tmp/lore-joint-memory-code-real-v3.PROTOTYPE.o994eB \
  --output /tmp/joint-memory-code-real-git-v3-no-reader.json \
  --no-reader --strict

bun run evaluate:joint-memory-code:real -- \
  --database /tmp/lore-joint-memory-code-real-v3.PROTOTYPE.o994eB \
  --output /tmp/joint-memory-code-real-git-v3-gpt56.json \
  --reader-provider codex \
  --model gpt-5.6-sol \
  --strict
```

The scratch database was created from the updated greenfield baseline. It indexed
the same exact trusted Git commits as v2. Both manifests contain 326 entries; the
base generation contains 4,173 Artifacts and the target contains 4,177. The reader
run reused 325 unchanged target files.

## Ablation result

| Variant | Route | Memory recall | Code recall | Anchor state | Reader pass | Avg reader evidence chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Code only | 50.0% | 50.0% | 83.3% | 0% | not run | 2,766 |
| Always-on Memory + Code | 50.0% | 100% | 83.3% | 0% | 66.7% (4/6) | 2,900 |
| Selective + typed revalidation | 100% | 100% | 100% | 100% | 100% (6/6) | 3,239 |

The fixed reader remained ephemeral, empty-directory, read-only, and isolated from
plugins, apps, browser access, repository rules, and the current working tree. It
received only the bounded evidence prompt under a strict JSON output schema.

## Adversarial result

Three integration cases now distinguish safe and unsafe ordinal use:

1. A stable multi-chunk declaration with only the cited chunk changed reproduces
   the masked context fingerprint, resolves the exact target Artifact, and reports
   `changed`.
2. Inserting one chunk before the cited chunk changes the fingerprint and returns
   `ambiguous` with no target Artifact.
3. Reordering chunks without changing the declaration chunk count also changes the
   fingerprint and returns `ambiguous`; the old implementation failed this test by
   binding the unrelated Artifact left at the old ordinal as `changed`.

A separate RLS adversarial test showed that the old direct-insert policy accepted a
well-shaped but forged context digest. The tightened policy rejects it by resolving
and comparing the live Artifact snapshot inside the Actor/RLS boundary.

In the real-Git suite, independently provable anchors remain `current` or `changed`.
The two structurally unstable submission-boundary anchors are `ambiguous`, and
GPT-5.6 answers from current Code while explicitly treating the historical anchor
as stale/ambiguous.

## Remaining falsification

- The corpus remains six hand-authored cases from one adjacent commit pair.
- Required-term and citation-shape scoring is deterministic, not an independent
  entailment judge.
- Production Postgres latency, code dense retrieval, broader dependency traversal,
  and the public joint MCP orchestration surface remain unevaluated.
