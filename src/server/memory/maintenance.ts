// The background memory job, in the order the layers depend on each other.
//
// Bounded, idempotent and retryable, because it runs from a scheduler that may
// fire twice, time out, or be interrupted mid-batch:
//
//   1. summaries   fold new events into the rolling state
//   2. extraction  propose memory from events past each thread's checkpoint
//   3. projection  rebuild or remove pages for whatever the lifecycle changed
//   4. consolidate expire, dedupe, surface conflicts
//
// NOT "propose procedures", which this line used to claim. consolidateMemory is
// called without a scope, and findProcedureCandidates only scans a scope it is
// given, so that stage cannot run — and nothing in src/ calls recordEpisode or
// promoteProcedure either, so the whole procedure surface is dead code today.
// Saying otherwise in a header is how a reader concludes a stage is covered.
//
// Extraction runs HERE rather than after every message on purpose: a per-message
// extractor would spend work on turns that produce nothing durable, and would
// make every reply wait for it.

import type { Db } from "../db";
import type { Store } from "../store";
import { consolidateMemory } from "./consolidate";
import { deterministicExtractor, runExtraction } from "./extract";
import { runProjections } from "./projection";
import { summarizerFromEnv } from "./summarizer-default";
import { refreshThreadSummary } from "./summary";

export interface MemoryMaintenanceReport {
  threads: number;
  summariesUpdated: number;
  extractionRuns: number;
  proposals: number;
  projected: number;
  projectionFailures: number;
  consolidation: Awaited<ReturnType<typeof consolidateMemory>>;
  errors: { threadId: string; stage: string; error: string }[];
}

// Threads with events the summary or the extractor has not caught up with. Only
// these are touched: a quiet thread costs nothing.
async function threadsNeedingWork(db: Db, limit: number): Promise<string[]> {
  const res = await db.query(
    `SELECT t.id FROM threads t
     LEFT JOIN extraction_checkpoints c ON c.thread_id = t.id
     WHERE t.last_event_sequence > t.last_summary_sequence
        OR t.last_event_sequence > coalesce(c.last_extracted_sequence, 0)
     ORDER BY t.updated_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => String(r.id));
}

export async function runMemoryMaintenance(
  db: Db,
  store: Store,
  args?: { limit?: number; threadId?: string },
): Promise<MemoryMaintenanceReport> {
  const limit = Math.min(Math.max(args?.limit ?? 25, 1), 100);
  const threads = args?.threadId ? [args.threadId] : await threadsNeedingWork(db, limit);
  const summarizer = summarizerFromEnv();
  const errors: MemoryMaintenanceReport["errors"] = [];

  let summariesUpdated = 0;
  let extractionRuns = 0;
  let proposals = 0;

  for (const threadId of threads) {
    // One thread failing must not abort the others: the report says what broke.
    try {
      const s = await refreshThreadSummary(db, summarizer, threadId);
      if (!s.unchanged) summariesUpdated++;
    } catch (e) {
      errors.push({
        threadId,
        stage: "summary",
        error: e instanceof Error ? e.message : "failed",
      });
    }
    try {
      // Scopes offered to the extractor: this thread, and nothing wider. An
      // extractor cannot reach an agent, another thread, or the vault unless a
      // caller explicitly allows it. `vault` used to be offered here and, under
      // the old widest-wins selection, always won — every thread statement became
      // ONE scope. This used to pass {scopeType:'thread', scopeId: threadId},
      // which after the scope collapse wrote where nothing reads: recall's
      // readable set is the one scope, and projectionSlug returns null for
      // anything else — so every background-extracted memory was WRITE-ONLY,
      // the exact failure the tool door exists to prevent.
      const r = await runExtraction(db, deterministicExtractor, { threadId });
      extractionRuns++;
      proposals += r.proposals;
    } catch (e) {
      errors.push({
        threadId,
        stage: "extraction",
        error: e instanceof Error ? e.message : "failed",
      });
      await db
        .query(
          "UPDATE extraction_checkpoints SET last_error = $2, updated_at = now() WHERE thread_id = $1",
          [threadId, e instanceof Error ? e.message : "failed"],
        )
        .catch(() => {});
    }
  }

  const projections = await runProjections(db, store, limit);
  const consolidation = await consolidateMemory(db, store, { limit });

  return {
    threads: threads.length,
    summariesUpdated,
    extractionRuns,
    proposals,
    projected: projections.projected,
    projectionFailures: projections.failed,
    consolidation,
    errors,
  };
}
