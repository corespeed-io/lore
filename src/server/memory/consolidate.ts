// Localized background consolidation.
//
// Never a global rewrite. Each job works on ONE narrow target — a memory key, a
// thread, a scope, a handful of projections — so a job is bounded, retryable and
// safe to interrupt. A consolidation pass that rewrote the whole store would be
// impossible to reason about and impossible to roll back.
//
// Runs under the same maintenance lease as the mention sweep, so exactly one
// background writer exists at a time whatever a scheduler does.

import type { Db } from "../db";
import type { Store } from "../store";
import { findProcedureCandidates } from "./episodes";
import { amendMemory, expireMemories, inRepoActor, rowToMemory } from "./items";
import { runProjections } from "./projection";

export interface ConsolidationReport {
  expired: number;
  duplicatesRetired: number;
  conflicts: number;
  procedureCandidates: { goal: string; episodeIds: string[]; successes: number }[];
  projectionsRepaired: number;
  projectionsFailed: number;
}

// Two committed memories that mean the same thing under the same key should not
// both be live. The active-key unique index prevents that for keyed memories, so
// this catches the unkeyed case: identical content in the same scope and type.
async function retireExactDuplicates(db: Db, limit: number): Promise<number> {
  const dupes = await db.query(
    `SELECT array_agg(id ORDER BY created_at) AS ids
     FROM memory_items
     WHERE status = 'committed' AND memory_key IS NULL
     GROUP BY scope_type, coalesce(scope_id, ''), memory_type, lower(btrim(content))
     HAVING count(*) > 1
     LIMIT $1`,
    [limit],
  );
  let retired = 0;
  for (const row of dupes.rows) {
    const ids = (row.ids as string[]).map(String);
    // Keep the oldest — it owns the provenance — and supersede the rest.
    const [keep, ...rest] = ids;
    for (const id of rest) {
      // THE LIMIT COUNTS GROUPS, and this loop is inside one. A single group of
      // 10,000 duplicates was 10,000 sequential transactions in one call — the
      // bound the caller asked for applied to the wrong dimension. Bounded by the
      // same limit, on the thing that actually costs: one transaction per row.
      // What is left over is not lost, because the sweep is idempotent and the
      // next pass sees the same group with fewer members.
      if (retired >= limit) return retired;
      // THROUGH THE CHOKEPOINT. This was a raw `UPDATE memory_items SET
      // status='superseded'` — a SECOND writer of authored state, with no lock, no
      // authority check and no status re-check. The invariant was stated per-file
      // ("one UPDATE memory_items left in THE FILE") and this is the other file.
      // A `forget` racing a sweep came out `superseded` rather than `revoked`, and
      // those are not interchangeable: AS_OF_SQL includes one and excludes the
      // other, so a revoked memory's content came back within reach of a
      // historical read. amendMemory locks the row, re-reads its status inside the
      // lock, refuses to move a retired one, and records the revision itself.
      //
      // supersedes_id is deliberately NOT set: it means "this row replaced <id>",
      // and a duplicate retired in favour of an OLDER row did not replace it — the
      // relationship is the other way round. The revision records which row
      // survived, which is the honest place for it.
      const done = await db.tx(async (q) => {
        // Re-read UNDER THE LOCK amendMemory is about to take. The group query
        // above ran in its own statement and selected rows that were committed
        // THEN; a forget landing in between is the race that produced a
        // `superseded` row where the user had asked for `revoked`. This is not a
        // second copy of the authority rule — amendMemory still enforces that and
        // would throw — it is the sweep asking whether this row is still its
        // business, so an ordinary concurrent revocation is a skip rather than a
        // crashed maintenance pass.
        const cur = await q("SELECT status FROM memory_items WHERE id = $1 FOR UPDATE", [id]);
        if (cur.rows[0]?.status !== "committed") return null;
        return amendMemory(q, {
          memoryId: id,
          operation: "SUPERSEDE",
          status: "superseded",
          actor: inRepoActor("consolidation"),
          reason: `exact duplicate of ${keep}`,
        });
      });
      // A duplicate the sweep did not retire is not work it did. Counting it
      // would report a retirement that never happened.
      if (!done || done.after.status !== "superseded") continue;
      retired++;
    }
  }
  return retired;
}

// Conflicts are SURFACED, never resolved automatically: if two sources disagree
// and neither outranks the other, a machine picking a winner is how a wrong fact
// becomes permanent.
async function countConflicts(db: Db): Promise<number> {
  const res = await db.query(
    "SELECT count(*)::int AS n FROM memory_items WHERE status = 'conflict'",
  );
  return Number(res.rows[0].n);
}

export async function consolidateMemory(
  db: Db,
  store: Store,
  args?: { limit?: number; scopeType?: "thread" | "agent" | "vault"; scopeId?: string | null },
): Promise<ConsolidationReport> {
  const limit = Math.min(Math.max(args?.limit ?? 50, 1), 200);

  const { expired } = await expireMemories(db, limit);
  const duplicatesRetired = await retireExactDuplicates(db, limit);
  const conflicts = await countConflicts(db);

  // Procedure candidates are proposed for the requested scope only — this is the
  // "localized" part. Without a scope, nothing is scanned.
  const procedureCandidates = args?.scopeType
    ? await findProcedureCandidates(db, {
        scopeType: args.scopeType,
        scopeId: args.scopeId,
        limit: 20,
      })
    : [];

  // Anything the lifecycle changed needs its page rebuilt or removed. Doing this
  // last means a memory retired earlier in this same pass is already handled.
  const projections = await runProjections(db, store, limit);

  return {
    expired,
    duplicatesRetired,
    conflicts,
    procedureCandidates,
    projectionsRepaired: projections.projected,
    projectionsFailed: projections.failed,
  };
}

// Backend health for the Graph Health panel: the numbers that say whether the
// memory system is keeping up, not just whether it is running.
export interface MemoryHealth {
  unprocessed_events: number;
  threads_with_stale_summaries: number;
  candidate_memories: number;
  conflicts: number;
  failed_projections: number;
  stale_active_projections: number;
  maintenance_lease: string | null;
}

export async function memoryHealth(db: Db): Promise<MemoryHealth> {
  const one = async (sql: string) => Number((await db.query(sql)).rows[0]?.n ?? 0);
  // ::text, the same driver hazard as the lease token one file over: without it
  // node-postgres hands back a JS Date and String() formats it as
  // "Sat Aug 01 2026 20:33:32 GMT+0000 (Coordinated Universal Time)" for a field
  // typed `string | null` as though it were already text. Report-only here — it is
  // never compared — but a health endpoint that prints one format on Postgres and
  // another on PGlite is a health endpoint nobody can diff.
  const lease = await db.query("SELECT maintenance_lease::text FROM meta WHERE id = 1");
  return {
    // Events past the extraction checkpoint (or with no checkpoint at all).
    unprocessed_events: await one(`
      SELECT count(*)::int AS n FROM conversation_events e
      LEFT JOIN extraction_checkpoints c ON c.thread_id = e.thread_id
      WHERE e.sequence > coalesce(c.last_extracted_sequence, 0)`),
    threads_with_stale_summaries: await one(`
      SELECT count(*)::int AS n FROM threads
      WHERE last_event_sequence > last_summary_sequence`),
    candidate_memories: await one(
      "SELECT count(*)::int AS n FROM memory_items WHERE status = 'candidate'",
    ),
    conflicts: await one("SELECT count(*)::int AS n FROM memory_items WHERE status = 'conflict'"),
    failed_projections: await one(
      "SELECT count(*)::int AS n FROM memory_items WHERE projection_status = 'failed'",
    ),
    // A retired memory whose page is still live: the leak this whole layer exists
    // to prevent, so it is worth counting rather than assuming.
    stale_active_projections: await one(`
      SELECT count(*)::int AS n FROM memory_items m
      JOIN pages p ON p.id = m.projection_page_id
      WHERE m.status <> 'committed' AND p.deleted_at IS NULL`),
    maintenance_lease: lease.rows[0]?.maintenance_lease
      ? String(lease.rows[0].maintenance_lease)
      : null,
  };
}

export { rowToMemory };
