import {
  chunkMemoryContent,
  MEMORY_CHUNK_MAXIMUM_CHARACTERS,
  MEMORY_CHUNKING_REVISION,
} from "../src/lib/memory-chunking";

const ITERATIONS = 250;
const WARMUP_ITERATIONS = 25;
const INPUT_CHARACTERS = 32_000;

function bounded(value: string): string {
  return Array.from(value).slice(0, INPUT_CHARACTERS).join("");
}

const corpora = {
  prose: bounded(
    "Lore preserves one coherent decision. Retrieval evidence keeps its exact formatting. ".repeat(
      500,
    ),
  ),
  markdown: bounded(
    Array.from(
      { length: 700 },
      (_, index) =>
        `## Decision ${index}\n\n- owner: platform\n- state: accepted\n- rationale: preserve exact evidence.\n\n`,
    ).join(""),
  ),
  cjk: bounded("这是一个用于验证中文分句、段落边界和确定性检索证据的记忆。\n\n".repeat(1_500)),
  emoji: "😀".repeat(INPUT_CHARACTERS),
} as const;

function percentile(samples: readonly number[], fraction: number): number {
  return samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))] ?? 0;
}

const results: Record<string, unknown>[] = [];
for (const [name, content] of Object.entries(corpora)) {
  for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration += 1) {
    chunkMemoryContent(content);
  }
  const samples: number[] = [];
  let chunks: string[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const startedAt = performance.now();
    chunks = chunkMemoryContent(content);
    samples.push(performance.now() - startedAt);
  }
  if (chunks.join("") !== content) throw new Error(`${name} did not reconstruct exactly`);
  if (
    chunks.some(
      (chunk) => Array.from(chunk).length > MEMORY_CHUNK_MAXIMUM_CHARACTERS || !chunk.trim(),
    )
  ) {
    throw new Error(`${name} produced an invalid chunk`);
  }
  samples.sort((left, right) => left - right);
  results.push({
    corpus: name,
    inputCharacters: Array.from(content).length,
    chunks: chunks.length,
    averageMilliseconds: samples.reduce((total, sample) => total + sample, 0) / samples.length,
    p50Milliseconds: percentile(samples, 0.5),
    p95Milliseconds: percentile(samples, 0.95),
  });
}

process.stdout.write(
  `${JSON.stringify(
    {
      revision: MEMORY_CHUNKING_REVISION,
      maximumCharacters: MEMORY_CHUNK_MAXIMUM_CHARACTERS,
      overlapCharacters: 0,
      iterations: ITERATIONS,
      results,
    },
    null,
    2,
  )}\n`,
);
