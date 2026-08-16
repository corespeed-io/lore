# Joint Memory + Code real-Git reader baseline

Date: 2026-08-14  
Revision: `joint-memory-code-real-git-v1`  
Reader: OpenAI `gpt-5.6-sol`, low reasoning effort  
Command:

```bash
bun run evaluate:joint-memory-code:real \
  --database /tmp/lore-joint-memory-code-real-v1.PROTOTYPE \
  --reader-provider codex \
  --model gpt-5.6-sol \
  --strict
```

## Decision

**Bounded real-repository gate: pass. Production/default-MCP gate: not evaluated.**

The evaluator indexed two exact immutable Lore commits from their local Git object
database rather than from the dirty working tree:

- base `f6a248c50730e5af99e8901dc3382e0a8218fedd`;
- target `2e3dbf00a1c7a2eccccb0ea6cbdcf710e15fefc2`.

Both manifests contain 326 entries. The base generation contains 4,173 Artifacts;
the target contains 4,177. On the persistent rerun, 325 target files reused their
immutable parse/chunk outputs.

The fixed reader ran through an ephemeral Codex process in an empty directory with
a read-only sandbox. It received only the bounded grouped evidence prompt, used a
strict JSON output schema, and had no Lore repository or conversation context.

## Ablation result

| Variant | Route | Memory recall | Code recall | Anchor state | Reader pass | Avg reader evidence chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Code only | 50.0% | 50.0% | 83.3% | 0% | not run | 2,766 |
| Always-on Memory + Code | 50.0% | 100% | 83.3% | 0% | 66.7% (4/6) | 2,900 |
| Selective + typed revalidation | 100% | 100% | 100% | 100% | 100% (6/6) | 3,155 |

The six cases cover two historical/current change questions, one governance
rationale, one current-code locator, one deleted-symbol false premise, and one
absent-symbol no-answer. Both no-answer cases correctly abstained.

Always-on union answered the two change questions semantically correctly, but it
failed the provenance contract: without anchor expansion it could cite historical
Memory and current Code but not the typed relationship connecting them. The
selective variant cited Memory, current Code, and the revalidated anchor together.
This result supports staged evidence orchestration; it does not establish that
adding more raw Memory improves answers.

## Red-green correctness finding

The first real run exposed a production correctness bug in Code Evidence
revalidation. Its candidate query combined content, path, and symbol matches, then
ordered by path/ordinal and applied `LIMIT 3`. In a file with many Artifacts, the
first three same-path chunks could starve the actual symbol match. Revalidation
would report `changed` while pointing `validatedArtifactId` at an import/header
chunk.

A deterministic integration test reproduced the exact false target. Candidate
priority is now:

1. same path and same content;
2. same content;
3. same symbol identity;
4. same path only.

Multiple path-only candidates now produce `ambiguous` rather than selecting the
first chunk. The red test failed on the Artifact id before the fix and passes after
it; the existing `current/moved/changed/deleted/ambiguous/unverifiable` test remains
green.

## Reader-packet finding

Prefix-only truncation also hid literal matches located in the middle of a bounded
6,000-unit structural Artifact. Code evidence now carries the retrieval match text
and constructs a bounded window around it. Anchor-expanded evidence uses the cited
symbol as its match. This kept `30 days`, `submit_memory_proposal`, and `onReviewed`
inside the actual reader input without increasing the 1,800-character per-passage
bound.

## Follow-up: split-declaration locator

One historical `createMemoryModule.propose` declaration spans multiple Artifacts.
Those chunks share `symbolKey` and `declarationKey`; the immutable citation does not
originally preserve `declarationChunkOrdinal`. After the declaration changed, Lore
could not select one target chunk without guessing, so the v1 run correctly
returned `ambiguous`.

The follow-up contract now preserves the ordinal in both Memory and Proposal Code
Evidence, copies it transactionally on human acceptance, exposes it through
OpenAPI/SDK/MCP, and uses `declarationKey + declarationChunkOrdinal` for changed
target selection. One red-green integration case covers a stable split declaration;
another proves that inserting a chunk before the citation returns `ambiguous`
instead of binding the old ordinal to unrelated content.

The real `createMemoryModule.propose` case remains intentionally `ambiguous`: its
declaration contracts from three chunks in the base revision to two in the target,
and the cited ordinal no longer exists. Equal-count structural reorder remains an
adversarial class; an ordinal alone must not be treated as semantic identity when
partitioning shifts.

## Scope limits

- Six hand-authored cases from one adjacent commit pair are not repository-disjoint.
- Required-term and citation-shape scoring is deterministic; there is no independent
  semantic entailment judge.
- The reader does not generate patches or run repository tests.
- The route policy is a deterministic English keyword baseline.
- Persistent PGlite timing is a test-harness measurement, not a production search SLO.
- Code dense retrieval, broader dependency traversal, and a public joint MCP
  orchestration surface remain unevaluated.
