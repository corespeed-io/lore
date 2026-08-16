# Code-Aware Memory Dependency Stress Evaluation

Date: 2026-08-14  
Suite revision: `code-aware-memory-dependency-stress-v1`  
Command: `bun run evaluate:code-aware-memory:stress`

## Decision

**Current decision: pass. Original baseline: 11/16.**

The unchanged suite now passes 16 of 16 cases (100%). Dependency resolution
accuracy moved from 44.4% to 100%, while ambiguity honesty and retrieval recall
remain 100%. The post-fix PGlite single-thread rerun measured p50 13.450 ms and
p95/max 19.770 ms.

The original deterministic run passed 11 of 16 cases (68.75%) with zero hard
failures. All five failures were missing dependency capabilities rather than false
resolved edges; the table below preserves that baseline.

| Gate | Result | Threshold |
| --- | ---: | ---: |
| Evidence recall@k | 100% (6/6) | 90% |
| Dependency resolution accuracy | 44.4% (4/9) | 95% |
| Ambiguity honesty | 100% (1/1) | 100% |

PGlite single-thread probe latency was p50 19.921 ms, p95/max 30.106 ms. This is
a deterministic correctness probe, not a production latency SLO.

## Original exact failures

| Case | Expected | Observed |
| --- | --- | --- |
| aliased import call | `renamedTarget` → `originalTarget` | unresolved |
| barrel re-export call | caller → declaration behind `barrel.ts` | unresolved |
| namespace import call | `tools.namespaceTarget` → exported function | unresolved |
| aliased type reference | `UserAlias` → `StressUser` | unresolved |
| TSX component reference | `StressScreen` → `StressCard` | no edge |

The current implementation did resolve default imports, ordinary JavaScript
imports, static method calls, and targets split across declaration chunks. It also
retained `client.run` as unresolved when multiple class methods could be plausible,
which is the correct behavior without type information.

## Retrieval controls

Exact retrieval passed SQL wildcard literals (`%_`), punctuation-only optional
chaining (`?.`), CJK literals, both symbols in one destructuring declaration, and
content from substantially malformed source. This supports keeping exact literal,
path, symbol, and fallback channels independent from semantic graph work.

## Design consequence

The implemented dependency layer is a bounded import/export binding resolver:

1. persist local-to-exported binding names for named, aliased, default, type-only,
   and namespace imports;
2. resolve bounded relative-module re-export chains with cycle detection;
3. extract JSX element references;
4. continue leaving arbitrary receiver calls such as `client.run()` unresolved
   until an optional type-aware adapter can prove the receiver type.

The parser/dependency derivation change bumped `CODE_INDEX_REVISION` to
`ast-grep-0.45.1-web-structural-graph-v4`. The unchanged stress suite is now a
passing regression gate; arbitrary receiver calls such as `client.run()` remain
unresolved rather than guessed.

## Deliberate limits

As in the foundation suite, files enter through the prepared deterministic fixture
seam. The suite excludes Git object authentication, LSP/type-checker integration,
Python/Go/Rust ecosystems, model answer quality, hosted Postgres plans, and
production concurrency/latency.
