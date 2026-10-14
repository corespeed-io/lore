# Evaluation tools

Manual benchmarks and evaluation harnesses are grouped by the capability they
measure. Run the existing `bun run` commands from the repository root; moving
their implementation here does not change command names. These tools are
excluded from the runtime image.

| Directory | Purpose | Command families (`bun run …`) |
| --- | --- | --- |
| [`harness/`](harness/README.md) | The eval harness: a change against a base ref on fixed slices of LongMemEval-S and LoCoMo, through the product path, with one pre-registered gate rule | `eval` |
| [`retrieval/`](retrieval/) | Synthetic and external-dataset retrieval runners, dataset parsing, and the shared retrieval suite | `benchmark:retrieval`, `benchmark:longmemeval*`, `benchmark:locomo*`, `benchmark:memoryagentbench*` |
| [`code/`](code/) | Code indexing/search and Memory-to-Code evidence evaluations | `benchmark:code-index`, `benchmark:code-search`, `evaluate:code-aware-memory`, `evaluate:code-aware-memory:stress` |
| [`context/`](context/) | Joint Memory + Code retrieval with synthetic and real-Git evidence | `evaluate:joint-memory-code`, `evaluate:joint-memory-code:real` |
| [`policy/`](policy/) | Agent retrieval-policy trials and runner adapters | `benchmark:retrieval-policy` |
| [`chunking/`](chunking/) | Memory chunk reconstruction and retrieval checks | `benchmark:memory-chunking` |
| [`graph/`](graph/) | Synthetic Graph renderer stress data | `benchmark:graph:seed`, `prototype:graph-scale` |
| [`shared/`](shared/) | Cross-family readers, judges, downloads, integrity checks, scoring, and usage accounting | Imported by the runners |

An executable entrypoint is named as a verb phrase (`run-retrieval.ts`,
`fetch-locomo.ts`, `evaluate-code-aware-memory.ts`, `seed-graph-benchmark.ts`) and
a library is named as a noun phrase (`retrieval.ts`, `retrieval-suite.ts`,
`locomo.ts`, `retrieval-policy.ts`). Do not reintroduce a `benchmark-` prefix: it
reads as both verb and noun, which is how `benchmark-retrieval.ts` and
`retrieval-benchmark.ts` once ended up side by side meaning opposite things.

`*` denotes related commands, including dataset fetch and profile variants; see
[package.json](../../package.json) for their exact names. Domain-specific helpers
and output schemas stay with their runner family. The policy MCP fixture server is
[`policy/serve-retrieval-policy-fixture.ts`](policy/serve-retrieval-policy-fixture.ts);
the root workspace supplies its `@modelcontextprotocol/server` dependency.

The standalone [dimension setup helper](retrieval/migrate-dimensions.ts)
documents how to prepare a disposable benchmark database for non-default embedding
dimensions. The Code SQL microbenchmark measures predicate strategies outside
production RLS; its timings are not application request latency.

### Frozen facts and raw evidence

[`retrieval/run-memory-evidence.ts`](retrieval/run-memory-evidence.ts) compares the
existing LongMemEval extracted-facts corpus with those same facts plus lexical
Episode evidence. It uses the complete cleaned S split, the native modules and
real RLS, a fixed reader and input cap, and the pinned upstream V1 judge rubric.
It is separate from the V2 benchmark and from hand-curated project Memory.

Use `LEGACY_BENCHMARK_DATABASE_URL` for the frozen 1536-dimensional corpus and
`BENCHMARK_DATABASE_URL` for a **different disposable database** migrated at 1536
dimensions. The legacy connection is explicitly read-only. Set
`AI_GATEWAY_API_KEY` for the existing Gemini embedding space, fixed reader, and
judge. The runner validates an exact-text cached-vector probe before reuse.

```sh
bun tools/evaluation/retrieval/fetch-longmemeval.ts s
curl --fail --location \
  https://raw.githubusercontent.com/xiaowu0162/LongMemEval/d6dc8b50a2d9ac0c99485ea28fa5755c62414c34/src/evaluation/evaluate_qa.py \
  --output evaluation/datasets/longmemeval/evaluate_qa.d6dc8b50.py
bun tools/evaluation/retrieval/run-memory-evidence.ts --prepare
bun tools/evaluation/retrieval/run-memory-evidence.ts
```

Downloads are checked against pinned hashes. `--max-cases N` limits a smoke run;
the default is all 500 questions. `LORE_DUAL_EVAL_OUTPUT` chooses the artifact
directory; a protocol mismatch refuses to reuse it. Per-question answers and
judgments are saved atomically and resumed. Identical reader inputs and identical
answers reuse their inference/judgment to avoid attributing sampling noise to
retrieval. A partial seed is never silently treated as complete. Results report
paired wins/losses, a paired bootstrap interval, per-category scores, session
recall, and native reader token usage. The shared cap uses UTF-16 code units;
actual token usage can differ between the two arms.

### Memory hit to raw source

[`retrieval/run-memory-source-expansion.ts`](retrieval/run-memory-source-expansion.ts)
adds raw Episode text to the same frozen Memory top 10. It replays the Memory
packets saved by `run-memory-evidence.ts`, so it needs that run's output directory,
not its databases. Source arms attach each hit's own raw session after the hit.
The benchmark's session key maps a fact to its session; production Memories have
no such link yet. Every arm keeps the Memory excerpts whole inside the 24,000-unit
cap. [`retrieval/memory-source-expansion.ts`](retrieval/memory-source-expansion.ts)
holds the pure packet, keyword-rewrite, diagnostic, and statistics rules.

`BENCHMARK_DATABASE_URL` names a disposable database migrated at 1536 dimensions
(`migrate-dimensions.ts 1536`). `--prepare` seeds every raw session with no model
call. `--embed` embeds the raw chunks through the Core Episode index with
`gemini-embedding-2` (`GEMINI_API_KEY`). `--retrieve` builds every arm's packet and
offline diagnostics, including the share of `has_answer` turns that reach the
reader. `--answer <arm> --profile <name>` answers one arm; Memory-only goes first,
and arms pair only within one profile. `baseline` is the 2026-10-12 Vercel reader
and GPT-4o judge and reuses its saved answers. `gemini-codex` calls the same reader
model directly and judges with GPT-5.5 through a logged-in Codex CLI. `--smoke`
limits a phase to five questions per category. `--rejudge <arm>` judges Memory-only
and that arm a second time, because the Codex judge has no temperature control.
The `combined-*` arms split the free budget between whole Memory-hit sessions and
independent raw excerpts. `--summarize` also replays a gate over the saved answers:
each arm counts only where the Memory-only answer declines for lack of evidence. An output directory's protocol may gain arms or fields,
but never change a value an earlier result ran with. Run one Codex-judged phase at
a time: two at twelve calls each hit ChatGPT rate limits.

```sh
DATABASE_URL=$BENCHMARK_DATABASE_URL bun tools/evaluation/retrieval/migrate-dimensions.ts 1536
bun tools/evaluation/retrieval/run-memory-source-expansion.ts --prepare
bun tools/evaluation/retrieval/run-memory-source-expansion.ts --embed
bun tools/evaluation/retrieval/run-memory-source-expansion.ts --retrieve
bun tools/evaluation/retrieval/run-memory-source-expansion.ts --answer source-session --profile gemini-codex
```

Data stays under [`evaluation/`](../../evaluation/): `external/` records dataset
manifests, `suites/` contains versioned inputs, and ignored `datasets/` and
`results/` hold downloaded data and run artifacts. Keep dataset and result paths
relative to the repository root.

Use the [technical reference](../../docs/reference.md#verify-changes) for setup,
provider configuration, dataset preparation, and runner parameters. The
[research index](../../docs/research/README.md) links source audits and
[retained baselines](../../docs/research/README.md#retained-benchmark-reports);
their results apply to the recorded revision and workload.
