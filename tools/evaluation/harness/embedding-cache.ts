import type { EmbeddingProvider, EmbeddingTask } from "@corespeed/lore-core";
import { sha256 } from "./hash";
import type { EvalStore } from "./store";

export interface EmbeddingCacheCounters {
  cached: number;
  embedded: number;
  requests: number;
  failures: number;
}

/**
 * A provider that answers from the store when it has embedded the exact text
 * before, under the same provider, model, width, revision, and task. Seeding a new
 * database, or a branch's, then costs nothing for text it has already seen. A
 * provider failure is counted, never hidden: the engine would quietly fall back to
 * lexical search, so the harness refuses any run that saw one.
 */
export function cachedEmbeddingProvider(
  provider: EmbeddingProvider,
  store: EvalStore,
): { provider: EmbeddingProvider; counters: EmbeddingCacheCounters } {
  const counters: EmbeddingCacheCounters = { cached: 0, embedded: 0, requests: 0, failures: 0 };
  const space = `${provider.provider}\u0000${provider.model}\u0000${provider.dimensions}\u0000${provider.revision}`;
  const keyFor = (text: string, task: EmbeddingTask) =>
    sha256(`${space}\u0000${task}\u0000${text}`);
  const cached: EmbeddingProvider = {
    provider: provider.provider,
    model: provider.model,
    dimensions: provider.dimensions,
    revision: provider.revision,
    ...(provider.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: provider.requestTimeoutMs }),
    async embed(texts, task) {
      const keys = texts.map((text) => keyFor(text, task));
      const vectors: Array<number[] | undefined> = keys.map((key) => {
        const hit = store.embedding(key);
        return hit ? Array.from(hit) : undefined;
      });
      const missing = vectors.flatMap((vector, index) => (vector ? [] : [index]));
      counters.cached += texts.length - missing.length;
      if (missing.length) {
        counters.requests += 1;
        let fresh: number[][];
        try {
          fresh = await provider.embed(
            missing.map((index) => texts[index] ?? ""),
            task,
          );
        } catch (error) {
          counters.failures += 1;
          throw error;
        }
        if (fresh.length !== missing.length) {
          counters.failures += 1;
          throw new Error("Embedding provider returned the wrong number of vectors");
        }
        counters.embedded += fresh.length;
        const entries: Array<[string, number[]]> = [];
        for (const [position, index] of missing.entries()) {
          const vector = fresh[position] ?? [];
          vectors[index] = vector;
          entries.push([keys[index] ?? "", vector]);
        }
        store.saveEmbeddings(entries);
      }
      return vectors.map((vector) => vector ?? []);
    },
  };
  return { provider: cached, counters };
}
