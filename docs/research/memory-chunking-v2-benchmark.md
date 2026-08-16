# Memory chunking v2 correctness and latency benchmark

Measured on 2026-08-14 with Bun 1.3.6 on an Apple M4 Pro with 24 GiB memory. Run:

```bash
bun run benchmark:memory-chunking
```

The benchmark warms each corpus 25 times and records 250 timed runs over the
maximum 32,000-character Memory input. Every run must reconstruct the original
content exactly, produce only nonblank chunks, and keep every chunk at or below
1,200 Unicode code points.

| Corpus | Chunks | Average | p50 | p95 |
| --- | ---: | ---: | ---: | ---: |
| English prose | 27 | 0.579 ms | 0.537 ms | 0.855 ms |
| Markdown sections/lists | 27 | 0.693 ms | 0.653 ms | 0.959 ms |
| CJK paragraphs | 28 | 1.462 ms | 1.406 ms | 1.857 ms |
| Astral emoji | 27 | 2.297 ms | 2.169 ms | 2.924 ms |

This admits `lore-memory-chunking-v2` on synchronous write-path latency: even the
astral-code-point stress case remained below 3 ms at p95 on this machine. It does
not establish retrieval-quality improvement. Quality claims still require the
revision-tagged LongMemEval, LoCoMo, and MemoryAgentBench evaluations with exact
answer-evidence recall, isolation, latency, and provider workload reported
separately.
