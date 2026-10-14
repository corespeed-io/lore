import { embeddingCacheKey } from "./embedding-cache";
import type { EvalStore, StoreQuery } from "./store";

export interface WarmReport {
  /** Vectors read from the source. */
  read: number;
  /** Of those, keys the store already held, each compared with the source's vector. */
  compared: number;
  /** The largest absolute difference found in any compared component. */
  maxDifference: number;
  /** Vectors written to the store. */
  added: number;
  seconds: number;
}

/**
 * Copy the document vectors another Lore database holds into the store, keyed
 * exactly as the harness keys them: space, task, and the chunk's text, which
 * maintenance embeds as is. The source session must be read-only, which is checked
 * first, so a frozen corpus is never written. Every key the store already holds is
 * compared first, and the copy stops before writing anything more if a vector
 * differs by more than `tolerance`.
 */
export async function warmFromDatabase(input: {
  /** A read-only session on a Lore database. */
  source: StoreQuery;
  store: EvalStore;
  tolerance?: number;
  batchSize?: number;
  log(message: string): void;
}): Promise<WarmReport> {
  const tolerance = input.tolerance ?? 1e-5;
  const batchSize = input.batchSize ?? 500;
  const startedAt = Date.now();
  const report: WarmReport = { read: 0, compared: 0, maxDifference: 0, added: 0, seconds: 0 };
  const readOnly = await input.source(
    "SELECT current_setting('default_transaction_read_only') AS setting",
  );
  if ((readOnly.rows[0] as { setting?: string } | undefined)?.setting !== "on") {
    throw new Error("The source session is not read-only");
  }
  let after: { generation: string; chunk: string } | undefined;
  for (;;) {
    const rows = (
      await input.source(
        `SELECT e.generation_id::text, e.chunk_id::text, g.embedding_provider AS provider,
           g.embedding_model AS model, g.embedding_dimensions AS dimensions,
           g.embedding_revision AS revision, c.content, e.embedding::real[] AS vector
         FROM memory_chunk_embeddings e
         JOIN embedding_generations g ON g.id = e.generation_id
         JOIN memory_chunks c ON c.id = e.chunk_id
         WHERE $1::uuid IS NULL OR (e.generation_id, e.chunk_id) > ($1::uuid, $2::uuid)
         ORDER BY e.generation_id, e.chunk_id
         LIMIT $3`,
        [after?.generation ?? null, after?.chunk ?? null, batchSize],
      )
    ).rows as Array<{
      generation_id: string;
      chunk_id: string;
      provider: string;
      model: string;
      dimensions: number;
      revision: string;
      content: string;
      vector: number[];
    }>;
    if (!rows.length) break;
    const last = rows.at(-1);
    if (last) after = { generation: last.generation_id, chunk: last.chunk_id };
    report.read += rows.length;
    // pgvector stores float32, printed in its shortest decimal form: round back to it.
    const batch = new Map<string, number[]>();
    for (const row of rows) {
      const key = embeddingCacheKey(row, "document", row.content);
      if (!batch.has(key)) batch.set(key, Array.from(Float32Array.from(row.vector)));
    }
    const stored = await input.store.embeddings([...batch.keys()]);
    const missing: Array<[string, number[]]> = [];
    for (const [key, vector] of batch) {
      const existing = stored.get(key);
      if (!existing) {
        missing.push([key, vector]);
        continue;
      }
      report.compared += 1;
      for (const [index, value] of vector.entries()) {
        const difference = Math.abs(value - (existing[index] ?? Number.NaN));
        if (!(difference <= report.maxDifference)) report.maxDifference = difference;
      }
      if (!(report.maxDifference <= tolerance) || existing.length !== vector.length) {
        throw new Error(
          `The source's vector for ${key} differs from the store's by ${report.maxDifference}; nothing more was copied`,
        );
      }
    }
    await input.store.saveEmbeddings(missing);
    report.added += missing.length;
    if (report.read % 10_000 < rows.length) {
      input.log(
        `warm: read ${report.read.toLocaleString("en-US")}, added ${report.added.toLocaleString("en-US")}, compared ${report.compared.toLocaleString("en-US")}`,
      );
    }
  }
  report.seconds = Math.round((Date.now() - startedAt) / 100) / 10;
  return report;
}
