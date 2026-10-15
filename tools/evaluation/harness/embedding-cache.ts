import type { EmbeddingProvider, EmbeddingTask } from "@corespeed/lore-core";
import { sha256 } from "./hash";
import type { EvalStore } from "./store";

/** The embedding space a vector belongs to. */
export interface EmbeddingSpace {
  provider: string;
  model: string;
  dimensions: number;
  revision: string;
}

/**
 * The store key of one embedding: its space, task, and exact text, NUL-separated.
 * `eval warm` computes the same key in SQL; a test holds the two equal.
 */
export function embeddingCacheKey(space: EmbeddingSpace, task: EmbeddingTask, text: string) {
  return sha256(
    [space.provider, space.model, String(space.dimensions), space.revision, task, text].join(
      "\u0000",
    ),
  );
}

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
  const keyFor = (text: string, task: EmbeddingTask) => embeddingCacheKey(provider, task, text);
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
      const stored = await store.embeddings(keys);
      const vectors: Array<number[] | undefined> = keys.map((key) => {
        const hit = stored.get(key);
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
        const entries: Array<[string, number[]]> = missing.map((index, position) => [
          keys[index] ?? "",
          fresh[position] ?? [],
        ]);
        // Another sandbox may have stored some of these keys meanwhile; embed with
        // the stored vectors, so every corpus and query uses one value per key.
        const stored = await store.saveEmbeddings(entries);
        for (const index of missing) {
          const winner = stored.get(keys[index] ?? "");
          if (!winner) throw new Error("An embedding is missing right after it was saved");
          vectors[index] = Array.from(winner);
        }
      }
      return vectors.map((vector) => vector ?? []);
    },
  };
  return { provider: cached, counters };
}
